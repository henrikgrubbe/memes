import {Command, CommandExecutor, FileSystem, Path} from "@effect/platform";
import {NodeCommandExecutor, NodeFileSystem, NodePath} from "@effect/platform-node";
import {Duration, Effect, Layer, Random} from "effect";
import {DoubleModerationError, ExecError} from "./errors.js";
import {AppConfigService, AppConfigLayer} from "./config.js";
import {ProvidersServiceTag, ProvidersLayer} from "./providers.js";
import {NotifierServiceTag, NotifierLayer} from "./notifier.js";
import {GitServiceTag, GitLayer} from "./git.js";

const RANDOM_TWISTS = [
    "Make it extremely dramatic.",
    "Use a medieval art style.",
    "Set it in space.",
    "Make it look like a warning label.",
    "Draw it as a motivational poster.",
    "Make it a Renaissance painting.",
    "Give it an 80s action movie vibe.",
    "Make it look like a government document.",
    "Use pixel art style.",
    "Make it extremely passive-aggressive.",
    "Set it in the 1950s.",
    "Make it look like a children's book illustration.",
];

// ---- Helpers --------------------------------------------------------------

// Runs a shell command, returns trimmed stdout.
const exec = (cmd: string): Effect.Effect<string, ExecError, CommandExecutor.CommandExecutor> =>
    Command.make("sh", "-c", cmd).pipe(
        Command.string,
        Effect.mapError((e) => new ExecError({cmd, detail: String(e)})),
        Effect.map((s) => s.trim()),
    );

const pickRandomTwist = (): Effect.Effect<string | null> =>
    Effect.gen(function* () {
        if ((yield* Random.next) >= 0.4) { return null; }
        return yield* Random.choice(RANDOM_TWISTS);
    });

// ---- Pipeline steps -------------------------------------------------------

function waitForJitter(): Effect.Effect<void, never, CommandExecutor.CommandExecutor | AppConfigService> {
    return Effect.gen(function* () {
        const config   = yield* AppConfigService;
        const runsJson = yield* exec(`gh api repos/${config.repo}/actions/runs --jq '.workflow_runs | map(select(.status == "in_progress")) | length'`).pipe(
            Effect.orElseSucceed(() => "1"),
        );
        const concurrentRuns = Math.min(isNaN(parseInt(runsJson, 10)) ? 1 : parseInt(runsJson, 10), 10);
        const jitterMs = concurrentRuns <= 1 ? 0 : Math.floor((yield* Random.next) * concurrentRuns * 13_000);
        if (jitterMs > 0) {
            yield* Effect.log(`${concurrentRuns} concurrent runs - waiting ${(jitterMs / 1000).toFixed(1)}s before first attempt...`);
            yield* Effect.sleep(Duration.millis(jitterMs));
        }
    });
}

export const generateImage = (prompt: string) =>
    ProvidersServiceTag.pipe(Effect.flatMap((p) => p.generateWithFallback(prompt)));

// ---- Program --------------------------------------------------------------

const program = Effect.gen(function* () {
    const config   = yield* AppConfigService;
    const fsys     = yield* FileSystem.FileSystem;
    const pathSvc  = yield* Path.Path;
    const memeId   = crypto.randomUUID();
    const memesDir = pathSvc.join(process.cwd(), "memes");
    const outFile  = pathSvc.join(memesDir, `${memeId}.jpg`);
    const twist    = yield* pickRandomTwist();

    const fullPrompt = `Make a meme: ${config.memePrompt}.${twist != null ? ` ${twist}` : ""}`;
    if (fullPrompt.length > 4000) {
        yield* Effect.logWarning(`Prompt truncated from ${fullPrompt.length} to 4000 characters.`);
    }
    const prompt = fullPrompt.slice(0, 4000);
    yield* fsys.makeDirectory(memesDir, {recursive: true});

    yield* Effect.log(`Starting generation for issue #${config.issueNumber}: "${config.memePrompt}"`);
    yield* waitForJitter();
    const {buffer, history} = yield* generateImage(prompt);
    yield* fsys.writeFile(outFile, buffer);
    yield* Effect.log(`Image saved: ${outFile}`);
    const git = yield* GitServiceTag;
    yield* git.commitAndPush(memeId);
    const notifier = yield* NotifierServiceTag;
    yield* notifier.notifySuccess({memeId, history, prompt, twist});
    yield* Effect.log("Done.");
}).pipe(
    Effect.catchTag("DoubleModerationError", (e) => Effect.gen(function* () {
        yield* Effect.logError(`Fatal: ${e.message}`);
        yield* NotifierServiceTag.pipe(Effect.flatMap((n) => n.notifyFailure(e.message, true)));
        return yield* Effect.die("failure-handled");
    })),
    Effect.catchAll((e) => Effect.gen(function* () {
        yield* Effect.logError(`Fatal: ${e.message}`);
        yield* NotifierServiceTag.pipe(Effect.flatMap((n) => n.notifyFailure(e.message)));
        return yield* Effect.die("failure-handled");
    })),
);

const AppLayer = Layer.mergeAll(
    AppConfigLayer,
    NodePath.layer,
    NodeFileSystem.layer,
    ProvidersLayer,
    NotifierLayer,
    GitLayer,
    NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
);

import {fileURLToPath} from "url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    Effect.runPromise(
        Effect.provide(program, AppLayer).pipe(
            Effect.tapError((e) => Effect.logError(e.message)),
        ),
    ).catch(() => process.exit(1));
}
