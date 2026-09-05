import { fileURLToPath } from "node:url";
import {
  NodeCommandExecutor,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { AppConfigLayer, AppConfigService } from "../shared/config.js";
import {
  failureDisposition,
  type FailureDisposition,
} from "../shared/disposition.js";
import { MemePublisherServiceTag } from "../shared/meme-publisher.js";
import { NotifierServiceTag } from "../shared/notifier.js";
import { ProvidersLayer, ProvidersServiceTag } from "../shared/providers.js";
import { buildMemePrompt, SagaServiceTag } from "../shared/saga.js";
import { GitLayer } from "./git.js";
import { MemePublisherLayer } from "./meme-publisher.js";
import { NotifierLayer } from "./notifier.js";
import { SagaLayer } from "./saga.js";
import { ShellLayer } from "./shell.js";

export const generateImage = (prompt: string, user?: string) =>
  ProvidersServiceTag.pipe(
    Effect.flatMap(({ generateWithFallback }) =>
      generateWithFallback(prompt, user),
    ),
  );

const sagaReadLog = (
  saga: string | null,
  canon: string | null,
): Effect.Effect<void> =>
  saga == null
    ? Effect.void
    : Effect.log(
        canon == null
          ? `Saga "${saga}" has no canon yet - generating without context.`
          : `Reading saga "${saga}" (${canon.length} chars of canon).`,
      );

const sagaContext = (
  saga: string | null,
  canon: string | null,
): { name: string; canon: string } | null =>
  saga != null && canon != null ? { name: saga, canon } : null;

const handleFailure = ({
  message,
  closeNotPlanned,
  history,
}: FailureDisposition) =>
  Effect.gen(function* () {
    yield* Effect.logError(`Fatal: ${message}`);
    const notifier = yield* NotifierServiceTag;
    yield* notifier.notifyFailure(message, closeNotPlanned, history);
    return yield* Effect.die("failure-handled");
  });

export const program = Effect.gen(function* () {
  const config = yield* AppConfigService;
  const saga = yield* SagaServiceTag;
  const memePublisher = yield* MemePublisherServiceTag;
  const notifier = yield* NotifierServiceTag;

  if (config.writeSaga != null && config.readSaga == null) {
    const updated = yield* saga.contribute(config.writeSaga, config.memePrompt);
    yield* notifier.notifySagaUpdate({
      saga: config.writeSaga,
      contribution: config.memePrompt,
      updated,
    });
    if (!updated) {
      return yield* Effect.die("failure-handled");
    }
    return yield* Effect.log("Done.");
  }

  const canon =
    config.readSaga == null ? null : yield* saga.read(config.readSaga);
  const prompt = buildMemePrompt(
    config.memePrompt,
    sagaContext(config.readSaga, canon),
  );

  yield* sagaReadLog(config.readSaga, canon);
  const preparedMeme = yield* memePublisher.prepare(config.issueNumber);
  yield* Effect.log(
    `Starting generation for issue #${config.issueNumber}: "${config.memePrompt}"`,
  );

  const { buffer, history, metadata } = yield* generateImage(
    prompt,
    config.requester,
  );

  yield* preparedMeme.publish(buffer);
  yield* notifier.notifySuccess({
    memeId: preparedMeme.memeId,
    history,
    prompt: config.memePrompt,
    metadata,
  });
  yield* config.writeSaga == null
    ? Effect.void
    : saga.contribute(config.writeSaga, config.memePrompt);
  yield* Effect.log("Done.");
}).pipe(
  Effect.catchTag("ModerationFailedError", (error) =>
    handleFailure(failureDisposition(error)),
  ),
  Effect.catchAll((error) => handleFailure(failureDisposition(error))),
);

const PlatformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
);

const ShellLive = ShellLayer.pipe(Layer.provide(PlatformLayer));
const GitLive = GitLayer.pipe(Layer.provide(ShellLive));
const MemePublisherLive = MemePublisherLayer.pipe(
  Layer.provide(Layer.mergeAll(PlatformLayer, GitLive)),
);
const NotifierLive = NotifierLayer.pipe(
  Layer.provide(Layer.mergeAll(AppConfigLayer, ShellLive)),
);
const SagaLive = SagaLayer.pipe(
  Layer.provide(Layer.mergeAll(AppConfigLayer, PlatformLayer, GitLive)),
);

const AppLayer = Layer.mergeAll(
  AppConfigLayer,
  ProvidersLayer,
  MemePublisherLive,
  NotifierLive,
  SagaLive,
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  Effect.runPromise(
    Effect.provide(program, AppLayer).pipe(
      Effect.tapError((error) => Effect.logError(error.message)),
    ),
  ).catch(() => process.exit(1));
}
