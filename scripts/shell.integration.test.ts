import { existsSync, readFileSync } from "node:fs";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ShellError, ShellTag, ShellLayer } from "./shell.js";
import { failureOfType } from "./test-support.js";

// Exercises the real Shell adapter against actual `sh -c` subprocesses.

const layer = ShellLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeFileSystem.layer,
      NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
    ),
  ),
);

const run = <A>(effect: Effect.Effect<A, ShellError, ShellTag>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

describe("Shell.run (integration)", () => {
  it("returns the command's trimmed stdout", async () => {
    const out = await run(
      ShellTag.pipe(Effect.flatMap((s) => s.run("echo hello"))),
    );
    expect(out).toBe("hello");
  });

  it("passes the string through a real shell (pipes, quoting)", async () => {
    const out = await run(
      ShellTag.pipe(
        Effect.flatMap((s) => s.run("printf 'a\\nb\\nc\\n' | wc -l")),
      ),
    );
    expect(out.trim()).toBe("3");
  });

  it("fails with ShellError when the command exits non-zero", async () => {
    const exit = await Effect.runPromise(
      ShellTag.pipe(
        Effect.flatMap((shell) => shell.run("printf failure >&2; exit 7")),
        Effect.provide(layer),
        Effect.exit,
      ),
    );

    const error = failureOfType(exit, ShellError);
    expect(error.command).toBe("printf failure >&2; exit 7");
    expect(error.detail).toContain("exit code 7");
    expect(error.detail).toContain("failure");
  });
});

describe("Shell.runWithBodyFile (integration)", () => {
  it("writes the body to a temp file the command can read, then cleans it up", async () => {
    let seenPath = "";
    const out = await run(
      ShellTag.pipe(
        Effect.flatMap((s) =>
          s.runWithBodyFile("txt", "payload-contents", (tmp) => {
            seenPath = tmp;
            return `cat ${tmp}`;
          }),
        ),
      ),
    );

    expect(out).toBe("payload-contents");
    expect(seenPath).toMatch(/\.txt$/);
    // The scoped temp file is removed once the effect completes.
    expect(existsSync(seenPath)).toBe(false);
  });

  it("gives the temp file the requested extension", async () => {
    let seenPath = "";
    await run(
      ShellTag.pipe(
        Effect.flatMap((s) =>
          s.runWithBodyFile("json", "{}", (tmp) => {
            seenPath = tmp;
            return `true`;
          }),
        ),
      ),
    );
    expect(seenPath).toMatch(/\.json$/);
  });

  it("writes the exact content to the file before running", async () => {
    // Capture the on-disk content from inside the command's lifetime.
    let onDisk = "";
    await run(
      ShellTag.pipe(
        Effect.flatMap((s) =>
          s.runWithBodyFile("txt", "line1\nline2", (tmp) => {
            onDisk = readFileSync(tmp, "utf8");
            return `true`;
          }),
        ),
      ),
    );
    expect(onDisk).toBe("line1\nline2");
  });
});
