import { Cause, Data, Effect, Exit, Schema } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { type AppConfig, makeRequestAppConfig } from "../../shared/config.js";
import { failureDisposition } from "../../shared/disposition.js";
import type { NotificationError } from "../../shared/errors.js";
import {
  type GenerationError,
  type GenerationResult,
  type ProvidersService,
} from "../../shared/providers.js";
import {
  buildMemePrompt,
  maxSagaContextChars,
  renderSagaContexts,
  sagaPath,
  type SagaCompressor,
  type SagaContext,
  type SagaContextShortener,
} from "../../shared/saga.js";
import {
  MemeRequestTask as MemeRequestTaskSchema,
  type MemeRequestTask,
} from "../task.js";
import type {
  DeliveryOutcome,
  FailureDeliveryOutcome,
  SuccessDeliveryOutcome,
} from "./hosted-delivery.js";
import type {
  HostedGitHubError,
  HostedGitHubRepository,
} from "./hosted-github.js";
import {
  deliverHostedCompletion,
  type SlackSender,
} from "./hosted-notifier.js";
import type {
  DeliveryReceiptStore,
  HostedObjectStorageError,
  MissingDeliveryReceipt,
} from "./hosted-object-storage.js";

const providerFrom = (result: GenerationResult): string =>
  result.history.find(({ status }) => status === "success")?.provider ??
  "unknown";

const generatedOutcome = (
  memeId: string,
  requestedPrompt: string,
  generationPrompt: string,
  result: GenerationResult,
): Omit<SuccessDeliveryOutcome, "imageUrl"> => ({
  generationPrompt,
  history: result.history,
  kind: "success",
  memeId,
  metadata: result.metadata,
  prompt: requestedPrompt,
  provider: providerFrom(result),
});

const failedOutcome = (error: GenerationError): FailureDeliveryOutcome => ({
  kind: "failure",
  ...failureDisposition(error),
});

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
  repository: HostedGitHubRepository,
  compressSaga: SagaCompressor,
) =>
  repository
    .foldSaga({
      derive: (canon) => compressSaga(saga, canon, prompt),
      name: saga,
      path: sagaPath(saga),
    })
    .pipe(Effect.asVoid);

const finishDelivery = (
  config: AppConfig,
  outcome: DeliveryOutcome,
  repository: HostedGitHubRepository,
  compressSaga: SagaCompressor,
  slack: SlackSender,
) => {
  const notification = deliverHostedCompletion(
    config,
    outcome,
    repository,
    slack,
  );
  return config.writeSaga == null || outcome.kind === "failure"
    ? notification
    : runIndependently(
        contributeSaga(
          config.writeSaga,
          config.memePrompt,
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
  receipt: MissingDeliveryReceipt,
  compressSaga: SagaCompressor,
  slack: SlackSender,
) =>
  Effect.gen(function* () {
    const outcome = yield* receipt.record({
      kind: "terminal-failure",
      outcome: failedOutcome(error),
    });
    yield* finishDelivery(config, outcome, repository, compressSaga, slack);
    return "processed" as const;
  });

const runGeneratedDelivery = (
  config: AppConfig,
  repository: HostedGitHubRepository,
  receipt: MissingDeliveryReceipt,
  compressSaga: SagaCompressor,
  shortenSagaContexts: SagaContextShortener,
  providers: ProvidersService,
  slack: SlackSender,
) =>
  Effect.gen(function* () {
    const contexts = yield* Effect.forEach(
      config.readSagas,
      (name) =>
        repository
          .readText(sagaPath(name))
          .pipe(
            Effect.map((canon): SagaContext => ({ canon: canon ?? "", name })),
          ),
      { concurrency: "unbounded" },
    );
    const context = renderSagaContexts(contexts);
    const contextBudget = maxSagaContextChars(config.memePrompt);
    const generationContext =
      config.readSagas.length > 1 &&
      context.length > contextBudget &&
      contextBudget > 0
        ? yield* shortenSagaContexts(contexts, contextBudget)
        : contexts;
    const prompt = buildMemePrompt(config.memePrompt, generationContext);

    return yield* providers.generateWithFallback(prompt, config.requester).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          persistGenerationFailure(
            config,
            error,
            repository,
            receipt,
            compressSaga,
            slack,
          ),
        onSuccess: (result) =>
          Effect.gen(function* () {
            const outcome = yield* receipt.record({
              kind: "image",
              image: result.buffer,
              outcome: generatedOutcome(
                repository.memeId,
                config.memePrompt,
                prompt,
                result,
              ),
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

const runSagaContextDelivery = (
  config: AppConfig & { readonly printSaga: string },
  repository: HostedGitHubRepository,
  slack: SlackSender,
) =>
  Effect.gen(function* () {
    const canon = yield* repository.readText(sagaPath(config.printSaga));
    yield* deliverHostedCompletion(
      config,
      {
        canon: canon ?? "",
        kind: "saga-context",
        saga: config.printSaga,
      },
      repository,
      slack,
    );
    return "processed" as const;
  });

const runSagaListDelivery = (
  config: AppConfig,
  repository: HostedGitHubRepository,
  slack: SlackSender,
) =>
  Effect.gen(function* () {
    const sagas = yield* repository.listSagas();
    yield* deliverHostedCompletion(
      config,
      { kind: "saga-list", sagas },
      repository,
      slack,
    );
    return "processed" as const;
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
    const folded = yield* repository.foldSaga({
      derive: (canon) =>
        compressSaga(config.writeSaga, canon, config.memePrompt),
      name: config.writeSaga,
      path: sagaPath(config.writeSaga),
    });
    yield* deliverHostedCompletion(config, outcome, repository, slack);
    return folded ? ("processed" as const) : ("resumed" as const);
  });

interface HostedTaskDependencies {
  readonly compressSaga: SagaCompressor;
  readonly providers: ProvidersService;
  readonly repository: HostedGitHubRepository;
  readonly shortenSagaContexts: SagaContextShortener;
  readonly slack: SlackSender;
  readonly storage: DeliveryReceiptStore;
}

export type HostedTaskError =
  HostedGitHubError | HostedObjectStorageError | NotificationError;
export type HostedTaskResult = "processed" | "resumed";

const runHostedTask = (
  task: MemeRequestTask,
  config: AppConfig,
  {
    compressSaga,
    providers,
    repository,
    shortenSagaContexts,
    slack,
    storage,
  }: HostedTaskDependencies,
): Effect.Effect<HostedTaskResult, HostedTaskError> =>
  Effect.gen(function* () {
    yield* Effect.log(
      `Processing queued issue #${task.issueNumber} from ${task.repo}`,
    );
    if (config.listSagas) {
      return yield* runSagaListDelivery(config, repository, slack);
    }

    if (config.printSaga != null) {
      return yield* runSagaContextDelivery(
        { ...config, printSaga: config.printSaga },
        repository,
        slack,
      );
    }

    if (config.writeSaga != null && config.readSagas.length === 0) {
      return yield* runWriteOnlyDelivery(
        { ...config, writeSaga: config.writeSaga },
        repository,
        compressSaga,
        slack,
      );
    }

    const receipt = yield* storage.receiptFor(config.memePrompt);
    if (receipt.status === "recorded") {
      yield* finishDelivery(
        config,
        receipt.outcome,
        repository,
        compressSaga,
        slack,
      );
      return "resumed" as const;
    }

    return yield* runGeneratedDelivery(
      config,
      repository,
      receipt,
      compressSaga,
      shortenSagaContexts,
      providers,
      slack,
    );
  });

export interface WorkerHttpResult {
  readonly body: Readonly<Record<string, string>>;
  readonly status: 200 | 503;
}

export interface QueuedDeliveryHandler {
  readonly handle: (
    requestBody: string,
  ) => Effect.Effect<WorkerHttpResult, never>;
}

export class WorkerMessageError extends Data.TaggedError("WorkerMessageError")<{
  readonly detail: string;
}> {
  public get message(): string {
    return this.detail;
  }
}

interface QueuedDeliveryDependencies {
  readonly allowedRepository: string;
  readonly compressSaga: SagaCompressor;
  readonly providers: Effect.Effect<ProvidersService, ConfigError>;
  readonly repositoryFor: (task: MemeRequestTask) => HostedGitHubRepository;
  readonly shortenSagaContexts: SagaContextShortener;
  readonly slack: SlackSender;
  readonly storageFor: (
    task: MemeRequestTask,
    memeId: string,
  ) => DeliveryReceiptStore;
}

type QueuedDeliveryError = ConfigError | HostedTaskError | WorkerMessageError;

// Scaleway's SQS-triggered container invocation posts the raw queue message
// body directly as the HTTP request body — there is no wrapping envelope.
const decodeEmbeddedTask = Schema.decodeUnknown(
  Schema.parseJson(MemeRequestTaskSchema),
);

const invalidMessage = () =>
  new WorkerMessageError({
    detail: "Queue request does not contain a valid meme task",
  });

const decodeQueuedTask = (
  requestBody: string,
): Effect.Effect<MemeRequestTask, WorkerMessageError> =>
  decodeEmbeddedTask(requestBody).pipe(Effect.mapError(invalidMessage));

const rejectMessage = (
  error: WorkerMessageError,
): Effect.Effect<WorkerHttpResult> =>
  Effect.logWarning(`Rejecting queue delivery: ${error.message}`).pipe(
    Effect.as({
      body: { disposition: "rejected", error: error.message },
      status: 200 as const,
    } satisfies WorkerHttpResult),
  );

const retryMessage = (): Effect.Effect<WorkerHttpResult> =>
  Effect.succeed({
    body: { disposition: "retry" },
    status: 503,
  });

// A retried delivery is invisible in the logs unless the cause is recorded, so
// a queue that quietly dead-letters after its retries looks identical to one
// that was never delivered at all.
const retryAfterFailure = (
  error: ConfigError | HostedTaskError,
): Effect.Effect<WorkerHttpResult> =>
  Effect.logError(
    `Retrying queue delivery after ${error._tag}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  ).pipe(Effect.zipRight(retryMessage()));

const processQueuedTask = (
  task: MemeRequestTask,
  dependencies: QueuedDeliveryDependencies,
): Effect.Effect<HostedTaskResult, QueuedDeliveryError> =>
  dependencies.providers.pipe(
    Effect.flatMap((providers) =>
      task.repo !== dependencies.allowedRepository
        ? Effect.fail(
            new WorkerMessageError({
              detail: "Queued task repository is not allowed",
            }),
          )
        : makeRequestAppConfig({
            issueBody: task.issueBody,
            issueNumber: task.issueNumber,
            repo: task.repo,
            requestedAt: task.requestedAt,
          }).pipe(
            Effect.mapError(
              () =>
                new WorkerMessageError({
                  detail: "Queued issue body is invalid",
                }),
            ),
            Effect.flatMap((config) => {
              const repository = dependencies.repositoryFor(task);
              return runHostedTask(task, config, {
                compressSaga: dependencies.compressSaga,
                providers,
                repository,
                shortenSagaContexts: dependencies.shortenSagaContexts,
                slack: dependencies.slack,
                storage: dependencies.storageFor(task, repository.memeId),
              });
            }),
          ),
    ),
  );

export const makeQueuedDeliveryHandler = (
  dependencies: QueuedDeliveryDependencies,
): QueuedDeliveryHandler => {
  const handle = (
    requestBody: string,
  ): Effect.Effect<WorkerHttpResult, never> =>
    decodeQueuedTask(requestBody).pipe(
      Effect.matchEffect({
        onFailure: rejectMessage,
        onSuccess: (task) =>
          processQueuedTask(task, dependencies).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                error instanceof WorkerMessageError
                  ? rejectMessage(error)
                  : retryAfterFailure(error),
              onSuccess: (disposition) =>
                Effect.succeed({
                  body: { disposition },
                  status: 200 as const,
                } satisfies WorkerHttpResult),
            }),
          ),
      }),
      Effect.catchAllCause((cause) =>
        Effect.logError(Cause.pretty(cause)).pipe(
          Effect.zipRight(retryMessage()),
        ),
      ),
    );

  return { handle };
};
