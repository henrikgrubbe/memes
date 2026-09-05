import { Effect, Layer } from "effect";
import type { AppConfig } from "../../shared/config.js";
import { MemePublishError } from "../../shared/errors.js";
import {
  makeMemePublisherLayer,
  type MemePublisherService,
} from "../../shared/meme-publisher.js";
import { NotifierServiceTag } from "../../shared/notifier.js";
import {
  type GenerationResult,
  ProvidersServiceTag,
} from "../../shared/providers.js";
import {
  buildMemePrompt,
  makeSagaLayer,
  sagaPath,
  type SagaCompressor,
  type SagaService,
} from "../../shared/saga.js";
import type { MemeRequestTask } from "../task.js";
import type {
  DeliveryOutcome,
  HostedGitHubError,
  HostedGitHubRepository,
  SuccessDeliveryOutcome,
} from "./hosted-github.js";
import {
  deliverHostedCompletion,
  makeHostedNotifierLayer,
  type SlackSender,
} from "./hosted-notifier.js";

interface PendingDelivery {
  readonly outcome?: DeliveryOutcome;
}

interface HostedCoordinator {
  readonly memePublisher: MemePublisherService;
  readonly recordFailure: (
    outcome: DeliveryOutcome,
  ) => Effect.Effect<void, HostedGitHubError>;
  readonly saga: SagaService;
  readonly setOutcome: (outcome: DeliveryOutcome) => Effect.Effect<void>;
}

const providerFrom = (result: GenerationResult): string =>
  result.history.find(({ status }) => status === "success")?.provider ??
  "unknown";

const makeCoordinator = (
  config: AppConfig,
  repository: HostedGitHubRepository,
  compressSaga: SagaCompressor,
): HostedCoordinator => {
  let pending: PendingDelivery = {};

  const requireOutcome = (): Effect.Effect<
    DeliveryOutcome,
    MemePublishError
  > => {
    if (pending.outcome == null) {
      return Effect.fail(
        new MemePublishError({
          detail: "Hosted publication outcome was not prepared",
        }),
      );
    }
    return Effect.succeed(pending.outcome);
  };

  const imageFile = (
    image: Uint8Array,
  ): ReadonlyArray<{ readonly content: Uint8Array; readonly path: string }> => [
    { content: image, path: `memes/${repository.memeId}.jpg` },
  ];

  const memePublisher: MemePublisherService = {
    prepare: () =>
      Effect.succeed({
        memeId: repository.memeId,
        publish: (image) =>
          requireOutcome().pipe(
            Effect.flatMap((outcome) =>
              repository
                .complete({
                  files: imageFile(image),
                  outcome,
                  sagaPending: config.writeSaga != null,
                })
                .pipe(
                  Effect.mapError(
                    (error) => new MemePublishError({ detail: error.message }),
                  ),
                  Effect.asVoid,
                ),
            ),
          ),
      }),
  };

  // The legacy saga interface is total. Hosted persistence defects are caught
  // by the HTTP handler and translated to a retryable response.
  const saga: SagaService = {
    read: (name) => repository.readText(sagaPath(name)).pipe(Effect.orDie),
    contribute: (name, prompt) =>
      requireOutcome().pipe(
        Effect.flatMap((outcome) =>
          repository
            .contributeSaga({
              outcome,
              saga: {
                derive: (canon) => compressSaga(name, canon, prompt),
                path: sagaPath(name),
              },
            })
            .pipe(Effect.orDie),
        ),
        Effect.orDie,
        Effect.as(true),
      ),
  };

  return {
    memePublisher,
    recordFailure: (outcome) =>
      repository.complete({ outcome }).pipe(Effect.asVoid),
    saga,
    setOutcome: (outcome) =>
      Effect.sync(() => {
        pending = { ...pending, outcome };
      }),
  };
};

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

const runNewDelivery = (config: AppConfig, coordinator: HostedCoordinator) =>
  Effect.gen(function* () {
    const providers = yield* ProvidersServiceTag;
    const notifier = yield* NotifierServiceTag;

    if (config.writeSaga != null && config.readSaga == null) {
      const outcome = {
        contribution: config.memePrompt,
        kind: "saga-updated" as const,
        saga: config.writeSaga,
        updated: true,
      };
      yield* coordinator.setOutcome(outcome);
      const updated = yield* coordinator.saga.contribute(
        config.writeSaga,
        config.memePrompt,
      );
      yield* notifier.notifySagaUpdate({
        contribution: config.memePrompt,
        saga: config.writeSaga,
        updated,
      });
      return "processed" as const;
    }

    const canon =
      config.readSaga == null
        ? null
        : yield* coordinator.saga.read(config.readSaga);
    const prompt = buildMemePrompt(
      config.memePrompt,
      sagaContext(config.readSaga, canon),
    );
    const prepared = yield* coordinator.memePublisher.prepare(
      config.issueNumber,
    );
    const result = yield* providers.generateWithFallback(
      prompt,
      config.requester,
    );
    yield* coordinator.setOutcome(
      generatedOutcome(prepared.memeId, config.memePrompt, result),
    );
    yield* prepared.publish(result.buffer);
    const notification = notifier.notifySuccess({
      history: result.history,
      memeId: prepared.memeId,
      metadata: result.metadata,
      prompt: config.memePrompt,
    });
    if (config.writeSaga != null) {
      yield* Effect.all(
        [
          coordinator.saga
            .contribute(config.writeSaga, config.memePrompt)
            .pipe(Effect.asVoid),
          notification,
        ],
        { concurrency: "unbounded" },
      );
    } else {
      yield* notification;
    }
    return "processed" as const;
  }).pipe(
    Effect.catchTag("ModerationFailedError", (error) => {
      const outcome = {
        closeNotPlanned: true,
        history: error.history,
        kind: "failure" as const,
        message: error.message,
      };
      return coordinator
        .recordFailure(outcome)
        .pipe(
          Effect.zipRight(coordinator.setOutcome(outcome)),
          Effect.zipRight(
            NotifierServiceTag.pipe(
              Effect.flatMap((notifier) =>
                notifier.notifyFailure(error.message, true, error.history),
              ),
            ),
          ),
          Effect.as("processed" as const),
        );
    }),
  );

export interface HostedTaskDependencies {
  readonly compressSaga: SagaCompressor;
  readonly repository: HostedGitHubRepository;
  readonly slack: SlackSender;
}

export type HostedTaskResult = "processed" | "resumed";

export const runHostedTask = (
  task: MemeRequestTask,
  config: AppConfig,
  { compressSaga, repository, slack }: HostedTaskDependencies,
) =>
  Effect.gen(function* () {
    const state = yield* repository.getDelivery();
    const coordinator = makeCoordinator(config, repository, compressSaga);
    if (state?.status === "completed") {
      yield* coordinator.setOutcome(state.outcome);
      const notification = deliverHostedCompletion(config, repository, slack);
      if (state.saga === "pending" && config.writeSaga != null) {
        yield* Effect.all(
          [
            coordinator.saga
              .contribute(config.writeSaga, config.memePrompt)
              .pipe(Effect.asVoid),
            notification,
          ],
          { concurrency: "unbounded" },
        );
      } else {
        yield* notification;
      }
      return "resumed" as const;
    }

    const requestLayer = Layer.mergeAll(
      makeMemePublisherLayer(coordinator.memePublisher),
      makeSagaLayer(coordinator.saga),
      makeHostedNotifierLayer(config, repository, slack),
    );
    yield* Effect.log(
      `Processing queued issue #${task.issueNumber} from ${task.repo}`,
    );
    return yield* runNewDelivery(config, coordinator).pipe(
      Effect.provide(requestLayer),
    );
  });
