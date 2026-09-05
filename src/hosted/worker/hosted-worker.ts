import { Cause, Effect, Exit } from "effect";
import type { AppConfig } from "../../shared/config.js";
import { failureDisposition } from "../../shared/disposition.js";
import type { NotificationError } from "../../shared/errors.js";
import {
  type GenerationError,
  type GenerationResult,
  ProvidersServiceTag,
} from "../../shared/providers.js";
import {
  buildMemePrompt,
  sagaPath,
  type SagaCompressor,
} from "../../shared/saga.js";
import type { MemeRequestTask } from "../task.js";
import type {
  DeliveryOutcome,
  FailureDeliveryOutcome,
  HostedGitHubError,
  HostedGitHubRepository,
  SuccessDeliveryOutcome,
} from "./hosted-github.js";
import {
  deliverHostedCompletion,
  type SlackSender,
} from "./hosted-notifier.js";

const providerFrom = (result: GenerationResult): string =>
  result.history.find(({ status }) => status === "success")?.provider ??
  "unknown";

const sagaContext = (
  saga: string | null,
  canon: string | null,
): { readonly canon: string; readonly name: string } | null =>
  saga != null && canon != null ? { canon, name: saga } : null;

const generatedOutcome = (
  memeId: string,
  prompt: string,
  result: GenerationResult,
): SuccessDeliveryOutcome => ({
  history: result.history,
  kind: "success",
  memeId,
  metadata: result.metadata,
  prompt,
  provider: providerFrom(result),
});

export type HostedGenerationDisposition = "terminal";

export const classifyHostedGenerationError = (
  error: GenerationError,
): HostedGenerationDisposition => {
  switch (error._tag) {
    case "AllProvidersExhaustedError":
    case "ModerationFailedError":
    case "ProviderError":
    case "QuotaExhaustedError":
    case "RateLimitError":
      return "terminal";
  }
};

const failedOutcome = (error: GenerationError): FailureDeliveryOutcome => {
  switch (classifyHostedGenerationError(error)) {
    case "terminal": {
      const disposition = failureDisposition(error);
      return { kind: "failure", ...disposition };
    }
  }
};

const runIndependently = <E1, R1, E2, R2>(
  first: Effect.Effect<void, E1, R1>,
  second: Effect.Effect<void, E2, R2>,
): Effect.Effect<void, E1 | E2, R1 | R2> =>
  Effect.all([Effect.exit(first), Effect.exit(second)] as const, {
    concurrency: "unbounded",
  }).pipe(
    Effect.flatMap(([firstExit, secondExit]) => {
      if (Exit.isFailure(firstExit)) {
        return Effect.failCause(
          Exit.isFailure(secondExit)
            ? Cause.parallel(firstExit.cause, secondExit.cause)
            : firstExit.cause,
        );
      }
      if (Exit.isFailure(secondExit)) {
        return Effect.failCause(secondExit.cause);
      }
      return Effect.void;
    }),
  );

const contributeSaga = (
  saga: string,
  prompt: string,
  outcome: DeliveryOutcome,
  repository: HostedGitHubRepository,
  compressSaga: SagaCompressor,
) =>
  repository
    .contributeSaga({
      outcome,
      saga: {
        derive: (canon) => compressSaga(saga, canon, prompt),
        path: sagaPath(saga),
      },
    })
    .pipe(Effect.asVoid);

const finishDelivery = (
  config: AppConfig,
  outcome: DeliveryOutcome,
  repository: HostedGitHubRepository,
  compressSaga: SagaCompressor,
  slack: SlackSender,
) => {
  const notification = deliverHostedCompletion(config, repository, slack);
  return config.writeSaga == null
    ? notification
    : runIndependently(
        contributeSaga(
          config.writeSaga,
          config.memePrompt,
          outcome,
          repository,
          compressSaga,
        ),
        notification,
      );
};

const persistGenerationFailure = (
  config: AppConfig,
  error: GenerationError,
  repository: HostedGitHubRepository,
  slack: SlackSender,
) =>
  Effect.gen(function* () {
    const outcome = failedOutcome(error);
    yield* repository.complete({ outcome });
    yield* deliverHostedCompletion(config, repository, slack);
    return "processed" as const;
  });

const runGeneratedDelivery = (
  config: AppConfig,
  repository: HostedGitHubRepository,
  compressSaga: SagaCompressor,
  slack: SlackSender,
) =>
  Effect.gen(function* () {
    const providers = yield* ProvidersServiceTag;
    const canon =
      config.readSaga == null
        ? null
        : yield* repository.readText(sagaPath(config.readSaga));
    const prompt = buildMemePrompt(
      config.memePrompt,
      sagaContext(config.readSaga, canon),
    );

    return yield* providers.generateWithFallback(prompt, config.requester).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          persistGenerationFailure(config, error, repository, slack),
        onSuccess: (result) =>
          Effect.gen(function* () {
            const outcome = generatedOutcome(
              repository.memeId,
              config.memePrompt,
              result,
            );
            yield* repository.complete({
              files: [
                {
                  content: result.buffer,
                  path: `memes/${repository.memeId}.jpg`,
                },
              ],
              outcome,
              sagaPending: config.writeSaga != null,
            });
            yield* finishDelivery(
              config,
              outcome,
              repository,
              compressSaga,
              slack,
            );
            return "processed" as const;
          }),
      }),
    );
  });

const runWriteOnlyDelivery = (
  config: AppConfig & { readonly writeSaga: string },
  repository: HostedGitHubRepository,
  compressSaga: SagaCompressor,
  slack: SlackSender,
) =>
  Effect.gen(function* () {
    const outcome = {
      contribution: config.memePrompt,
      kind: "saga-updated" as const,
      saga: config.writeSaga,
      updated: true,
    };
    yield* contributeSaga(
      config.writeSaga,
      config.memePrompt,
      outcome,
      repository,
      compressSaga,
    );
    yield* deliverHostedCompletion(config, repository, slack);
    return "processed" as const;
  });

export interface HostedTaskDependencies {
  readonly compressSaga: SagaCompressor;
  readonly repository: HostedGitHubRepository;
  readonly slack: SlackSender;
}

export type HostedTaskError = HostedGitHubError | NotificationError;
export type HostedTaskResult = "processed" | "resumed";

export const runHostedTask = (
  task: MemeRequestTask,
  config: AppConfig,
  { compressSaga, repository, slack }: HostedTaskDependencies,
): Effect.Effect<HostedTaskResult, HostedTaskError, ProvidersServiceTag> =>
  Effect.gen(function* () {
    const state = yield* repository.getDelivery();
    if (state?.status === "completed") {
      if (state.saga === "pending" && config.writeSaga != null) {
        yield* finishDelivery(
          config,
          state.outcome,
          repository,
          compressSaga,
          slack,
        );
      } else {
        yield* deliverHostedCompletion(config, repository, slack);
      }
      return "resumed" as const;
    }

    yield* Effect.log(
      `Processing queued issue #${task.issueNumber} from ${task.repo}`,
    );
    return config.writeSaga != null && config.readSaga == null
      ? yield* runWriteOnlyDelivery(
          { ...config, writeSaga: config.writeSaga },
          repository,
          compressSaga,
          slack,
        )
      : yield* runGeneratedDelivery(config, repository, compressSaga, slack);
  });
