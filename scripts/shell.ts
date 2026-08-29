import {Command, CommandExecutor, FileSystem} from "@effect/platform";
import {Context, Data, Effect, Layer} from "effect";

// ---- Shell ------------------------------------------------------------------
// Deep interface: run a subprocess through `sh -c` and get its trimmed stdout.
// The sh invocation, output trimming, temp-file bodies (for tools that read a
// payload from a file, like `gh --body-file` or `curl -d @file`), and error
// mapping all live behind this seam, so callers state intent and pick their own
// failure policy (retry, ignore) on a single typed error.

export class ShellError extends Data.TaggedError("ShellError")<{
    readonly command: string;
    readonly detail: string;
}> {
    public get message(): string {
        return `${this.command}: ${this.detail}`;
    }
}

export interface Shell {
    readonly run: (command: string) => Effect.Effect<string, ShellError>;
    readonly runWithBodyFile: (
        extension: string,
        content: string,
        command: (path: string) => string,
    ) => Effect.Effect<string, ShellError>;
}

export class ShellTag extends Context.Tag("Shell")<ShellTag, Shell>() {}

// ---- Test helper ------------------------------------------------------------

export const makeShellLayer = (impl: Shell): Layer.Layer<ShellTag> => Layer.succeed(ShellTag, impl);

// ---- Real adapter -----------------------------------------------------------

type ShellDeps = CommandExecutor.CommandExecutor | FileSystem.FileSystem;

const rawRun = (
    command: string,
): Effect.Effect<string, ShellError, CommandExecutor.CommandExecutor> =>
    Command.make("sh", "-c", command).pipe(
        Command.string,
        Effect.mapError((error) => new ShellError({command, detail: String(error)})),
        Effect.map((output) => output.trim()),
    );

const rawRunWithBodyFile = (
    extension: string,
    content: string,
    command: (path: string) => string,
): Effect.Effect<string, ShellError, ShellDeps> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* fs
            .makeTempFileScoped({
                suffix: `.${extension}`,
            })
            .pipe(
                Effect.mapError(
                    (error) =>
                        new ShellError({
                            command: "makeTempFile",
                            detail: String(error),
                        }),
                ),
            );
        yield* fs.writeFileString(file, content).pipe(
            Effect.mapError(
                (error) =>
                    new ShellError({
                        command: "writeFile",
                        detail: String(error),
                    }),
            ),
        );

        return yield* rawRun(command(file));
    }).pipe(Effect.scoped);

export const ShellLayer: Layer.Layer<ShellTag, never, ShellDeps> = Layer.effect(
    ShellTag,
    Effect.gen(function* () {
        const executor = yield* CommandExecutor.CommandExecutor;
        const fs = yield* FileSystem.FileSystem;
        const provide = <A>(
            effect: Effect.Effect<A, ShellError, ShellDeps>,
        ): Effect.Effect<A, ShellError> =>
            effect.pipe(
                Effect.provideService(CommandExecutor.CommandExecutor, executor),
                Effect.provideService(FileSystem.FileSystem, fs),
            );

        return {
            run: (command) => provide(rawRun(command)),
            runWithBodyFile: (extension, content, command) =>
                provide(rawRunWithBodyFile(extension, content, command)),
        } satisfies Shell;
    }),
);
