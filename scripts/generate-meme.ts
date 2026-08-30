import { fileURLToPath } from "node:url";
import { FileSystem, Path } from "@effect/platform";
import {
  NodeCommandExecutor,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { AppConfigLayer, AppConfigService } from "./config.js";
import { failureDisposition, type FailureDisposition } from "./disposition.js";
import { GitLayer, GitServiceTag } from "./git.js";
import { NotifierLayer, NotifierServiceTag } from "./notifier.js";
import { ProvidersLayer, ProvidersServiceTag } from "./providers.js";
import { buildMemePrompt, SagaLayer, SagaServiceTag } from "./saga.js";
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const saga = yield* SagaServiceTag;
  const git = yield* GitServiceTag;
  const notifier = yield* NotifierServiceTag;

  const memeId = crypto.randomUUID();
  const memesDir = path.join(process.cwd(), "memes");
  const outFile = path.join(memesDir, `${memeId}.jpg`);
  const canon =
    config.readSaga == null ? null : yield* saga.read(config.readSaga);
  const prompt = buildMemePrompt(
    config.memePrompt,
    sagaContext(config.readSaga, canon),
  );

  yield* sagaReadLog(config.readSaga, canon);
  yield* fs.makeDirectory(memesDir, { recursive: true });
  yield* Effect.log(
    `Starting generation for issue #${config.issueNumber}: "${config.memePrompt}"`,
  );

  const { buffer, history, metadata } = yield* generateImage(
    prompt,
    config.requester,
  );

  const stageMeme = fs.writeFile(outFile, buffer).pipe(
    Effect.orDie,
    Effect.tap(() => Effect.log(`Image saved: ${outFile}`)),
    Effect.as([`memes/${memeId}.jpg`]),
  );

  yield* git.commitToMain({
    message: `Add meme for issue #${config.issueNumber} (${memeId})`,
    stage: stageMeme,
  });
  yield* notifier.notifySuccess({
    memeId,
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
const NotifierLive = NotifierLayer.pipe(
  Layer.provide(Layer.mergeAll(AppConfigLayer, ShellLive)),
);
const SagaLive = SagaLayer.pipe(
  Layer.provide(Layer.mergeAll(AppConfigLayer, PlatformLayer, GitLive)),
);

const AppLayer = Layer.mergeAll(
  AppConfigLayer,
  PlatformLayer,
  ProvidersLayer,
  GitLive,
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
