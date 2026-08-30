import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { Chunk, Context, Data, Effect, Layer, Stream } from "effect";

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

export const makeShellLayer = (impl: Shell): Layer.Layer<ShellTag> =>
  Layer.succeed(ShellTag, impl);

type ShellDeps = CommandExecutor.CommandExecutor | FileSystem.FileSystem;

const decode = (chunks: Chunk.Chunk<Uint8Array>): string => {
  const decoder = new TextDecoder();
  return (
    Chunk.reduce(
      chunks,
      "",
      (text, bytes) => text + decoder.decode(bytes, { stream: true }),
    ) + decoder.decode()
  );
};

const rawRun = (
  command: string,
): Effect.Effect<string, ShellError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Command.start(Command.make("sh", "-c", command));
      return yield* Effect.all(
        {
          stdout: Stream.runCollect(process.stdout).pipe(Effect.map(decode)),
          stderr: Stream.runCollect(process.stderr).pipe(Effect.map(decode)),
          exitCode: process.exitCode,
        },
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(
    Effect.mapError(
      (error) => new ShellError({ command, detail: String(error) }),
    ),
    Effect.flatMap(({ exitCode, stderr, stdout }) =>
      exitCode === 0
        ? Effect.succeed(stdout.trim())
        : Effect.fail(
            new ShellError({
              command,
              detail: [`exit code ${exitCode}`, stderr.trim() || stdout.trim()]
                .filter((detail) => detail !== "")
                .join(": "),
            }),
          ),
    ),
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
