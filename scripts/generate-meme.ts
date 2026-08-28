import {fileURLToPath} from "node:url";
import {FileSystem, Path} from "@effect/platform";
import {NodeCommandExecutor, NodeFileSystem, NodePath} from "@effect/platform-node";
import {Effect, Layer} from "effect";
import {AppConfigService, AppConfigLayer} from "./config.js";
import {ProvidersServiceTag, ProvidersLayer} from "./providers.js";
import type {HistoryEntry} from "./providers.js";
import {NotifierServiceTag, NotifierLayer} from "./notifier.js";
import {GitServiceTag, GitLayer} from "./git.js";
import {SagaServiceTag, SagaLayer, buildMemePrompt} from "./saga.js";

// ---- Pipeline steps -------------------------------------------------------

export const generateImage = (prompt: string, user?: string) =>
    ProvidersServiceTag.pipe(Effect.flatMap((p) => p.generateWithFallback(prompt, user)));

// ---- Failure handling -----------------------------------------------------

const handleFailure = (message: string, closeNotPlanned: boolean, history?: ReadonlyArray<HistoryEntry>) =>
    Effect.gen(function* () {
        yield* Effect.logError(`Fatal: ${message}`);
        const notifier = yield* NotifierServiceTag;
        yield* notifier.notifyFailure(message, closeNotPlanned, history);
        return yield* Effect.die("failure-handled");
    });

// ---- Program --------------------------------------------------------------

const program = Effect.gen(function* () {
    const config   = yield* AppConfigService;
    const fsys     = yield* FileSystem.FileSystem;
    const pathSvc  = yield* Path.Path;
    const memeId   = crypto.randomUUID();
    const memesDir = pathSvc.join(process.cwd(), "memes");
    const outFile  = pathSvc.join(memesDir, `${memeId}.jpg`);

    const saga = yield* SagaServiceTag;
    const canon = config.readSaga != null ? yield* saga.read(config.readSaga) : null;
    if (config.readSaga != null) {
        yield* Effect.log(canon != null
            ? `Reading saga "${config.readSaga}" (${canon.length} chars of canon).`
            : `Saga "${config.readSaga}" has no canon yet - generating without context.`);
    }
    const prompt = buildMemePrompt(config.memePrompt, config.readSaga != null && canon != null ? {name: config.readSaga, canon} : null);
    yield* fsys.makeDirectory(memesDir, {recursive: true});

    yield* Effect.log(`Starting generation for issue #${config.issueNumber}: "${config.memePrompt}"`);
    const {buffer, history, metadata} = yield* generateImage(prompt, config.requester);
    yield* fsys.writeFile(outFile, buffer);
    yield* Effect.log(`Image saved: ${outFile}`);
    const git = yield* GitServiceTag;
    yield* git.commitAndPush(memeId);
    const notifier = yield* NotifierServiceTag;
    yield* notifier.notifySuccess({memeId, history, prompt: config.memePrompt, metadata});
    if (config.writeSaga != null) {
        yield* saga.contribute(config.writeSaga, config.memePrompt);
    }
    yield* Effect.log("Done.");
}).pipe(
    // A moderation failure is a terminal content problem: close the issue.
    Effect.catchTag("ModerationFailedError", (e) => handleFailure(e.message, true, e.history)),
    // Everything else is transient/infra: report but leave the issue open.
    Effect.catchAll((e) => handleFailure(e.message, false, "history" in e ? e.history : undefined)),
);

const PlatformLayer = Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
);

const AppLayer = Layer.mergeAll(
    AppConfigLayer,
    PlatformLayer,
    ProvidersLayer,
    NotifierLayer,
    GitLayer,
    SagaLayer,
).pipe(
    Layer.provide(Layer.mergeAll(AppConfigLayer, PlatformLayer)),
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    Effect.runPromise(
        Effect.provide(program, AppLayer).pipe(
            Effect.tapError((e) => Effect.logError(e.message)),
        ),
    ).catch(() => process.exit(1));
}
