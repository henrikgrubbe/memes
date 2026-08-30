import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { GitLayer, GitServiceTag } from "./git.js";
import { makeShellLayer, type Shell, ShellError } from "./shell.js";

const identityCommands = [
  `git config user.name "github-actions[bot]"`,
  `git config user.email "github-actions[bot]@users.noreply.github.com"`,
];

const recordingShell = (commands: string[], rejectedPushes = 0): Shell => {
  let pushes = 0;

  return {
    run: (command) =>
      Effect.suspend(() => {
        commands.push(command);
        if (command === "git push origin HEAD" && pushes++ < rejectedPushes) {
          return Effect.fail(new ShellError({ command, detail: "rejected" }));
        }
        return Effect.succeed("");
      }),
    runWithBodyFile: () => Effect.die("Unexpected body-file command"),
  };
};

const runCommit = (
  commands: string[],
  stage: Effect.Effect<ReadonlyArray<string>>,
  rejectedPushes = 0,
) => {
  const layer = GitLayer.pipe(
    Layer.provide(makeShellLayer(recordingShell(commands, rejectedPushes))),
  );
  const program = GitServiceTag.pipe(
    Effect.flatMap((git) =>
      git.commitToMain({ message: "Test commit", stage }),
    ),
  );
  return Effect.runPromise(program.pipe(Effect.provide(layer)));
};

describe("GitService.commitToMain through the Shell seam", () => {
  it("configures identity, pulls, stages, commits, and pushes in order", async () => {
    const commands: string[] = [];

    await runCommit(commands, Effect.succeed(["first.txt", "second.txt"]));

    expect(commands).toEqual([
      ...identityCommands,
      "git pull --rebase origin main",
      `git add "first.txt"`,
      `git add "second.txt"`,
      `git commit -m "Test commit"`,
      "git push origin HEAD",
    ]);
  });

  it("drops a rejected commit and re-derives staged paths after pulling again", async () => {
    const commands: string[] = [];
    let derivations = 0;
    const stage = Effect.sync(() => {
      derivations += 1;
      return [`derived-${derivations}.txt`];
    });

    await runCommit(commands, stage, 1);

    expect(derivations).toBe(2);
    expect(commands).toEqual([
      ...identityCommands,
      "git pull --rebase origin main",
      `git add "derived-1.txt"`,
      `git commit -m "Test commit"`,
      "git push origin HEAD",
      "git reset --hard HEAD~1",
      ...identityCommands,
      "git pull --rebase origin main",
      `git add "derived-2.txt"`,
      `git commit -m "Test commit"`,
      "git push origin HEAD",
    ]);
  });
});
