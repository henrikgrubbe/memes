import {Command, CommandExecutor, FileSystem} from "@effect/platform";
import {Context, Data, Effect, Layer} from "effect";

// ---- Shell ------------------------------------------------------------------
// Deep interface: run a subprocess through `sh -c` and get its trimmed stdout.
// The sh invocation, output trimming, temp-file bodies (for tools that read a
// payload from a file, like `gh --body-file` or `curl -d @file`), and error
// mapping all live behind this seam, so callers state intent and pick their own
// failure policy (retry, ignore) on a single typed error.

export class ShellError extends Data.TaggedError("ShellError")<{
    command: string;
    detail:  string;
}> {}

export interface Shell {
    run(command: string): Effect.Effect<string, ShellError>;
    // Write `content` to a scoped temp file with the given extension, then run
    // the command built from its path. The file is removed when the effect ends.
    runWithBodyFile(ext: string, content: string, command: (path: string) => string): Effect.Effect<string, ShellError>;
}

export class ShellTag extends Context.Tag("Shell")<ShellTag, Shell>() {}

// ---- Test helper ------------------------------------------------------------

/** Build a Layer from a pre-constructed Shell implementation (bypasses real subprocesses). */
export const makeShellLayer = (impl: Shell): Layer.Layer<ShellTag> =>
    Layer.succeed(ShellTag, impl);

// ---- Real adapter -----------------------------------------------------------

type ShellDeps = CommandExecutor.CommandExecutor | FileSystem.FileSystem;

const rawRun = (command: string): Effect.Effect<string, ShellError, CommandExecutor.CommandExecutor> =>
    Command.make("sh", "-c", command).pipe(
        Command.string,
        Effect.mapError((e) => new ShellError({command, detail: String(e)})),
        Effect.map((s) => s.trim()),
    );

const rawRunWithBodyFile = (ext: string, content: string, command: (path: string) => string): Effect.Effect<string, ShellError, ShellDeps> =>
    Effect.gen(function* () {
        const fs  = yield* FileSystem.FileSystem;
        const tmp = yield* fs.makeTempFileScoped({suffix: `.${ext}`}).pipe(
            Effect.mapError((e) => new ShellError({command: "makeTempFile", detail: String(e)})),
        );
        yield* fs.writeFileString(tmp, content).pipe(
            Effect.mapError((e) => new ShellError({command: "writeFile", detail: String(e)})),
        );
        return yield* rawRun(command(tmp));
    }).pipe(Effect.scoped);

export const ShellLayer: Layer.Layer<ShellTag, never, ShellDeps> =
    Layer.effect(
        ShellTag,
        Effect.gen(function* () {
            // Capture dependencies once so the service methods require nothing (R = never).
            const executor = yield* CommandExecutor.CommandExecutor;
            const fs       = yield* FileSystem.FileSystem;
            const provide  = <A>(effect: Effect.Effect<A, ShellError, ShellDeps>): Effect.Effect<A, ShellError> =>
                effect.pipe(
                    Effect.provideService(CommandExecutor.CommandExecutor, executor),
                    Effect.provideService(FileSystem.FileSystem, fs),
                );
            return {
                run:             (command)               => provide(rawRun(command)),
                runWithBodyFile: (ext, content, command) => provide(rawRunWithBodyFile(ext, content, command)),
            } satisfies Shell;
        }),
    );
