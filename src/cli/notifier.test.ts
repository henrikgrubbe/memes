import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { AppConfigService, type AppConfig } from "../shared/config.js";
import { NotifierLayer, NotifierServiceTag } from "./notifier.js";
import { makeShellLayer, type Shell } from "./shell.js";

describe("NotifierService through the Shell seam", () => {
  const config: AppConfig = {
    issueNumber: "42",
    repo: "o/r",
    slackWebhookUrl: "https://hooks.slack/x",
    requester: "U1",
    memePrompt: "make a meme",
    channel: "#memes",
    slackLink: "https://slack/msg",
    readSaga: null,
    writeSaga: null,
  };

  // In-memory Shell recorder: captures the commands it's asked to run in order.
  const recordingShell = (commands: string[]): Shell => ({
    run: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return "";
      }),
    runWithBodyFile: (_ext, _content, command) =>
      Effect.sync(() => {
        commands.push(command("/tmp/body"));
        return "";
      }),
  });

  const run = (
    effect: Effect.Effect<void, never, NotifierServiceTag>,
    commands: string[],
  ) => {
    const layer = NotifierLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          makeShellLayer(recordingShell(commands)),
          Layer.succeed(AppConfigService, config),
        ),
      ),
    );
    return Effect.runPromise(effect.pipe(Effect.provide(layer)));
  };

  it("posts to Slack before issue housekeeping on success", async () => {
    const commands: string[] = [];
    await run(
      NotifierServiceTag.pipe(
        Effect.flatMap((n) =>
          n.notifySuccess({
            memeId: "meme-1",
            history: [{ provider: "OpenAI", status: "success" }],
            prompt: "make a meme",
          }),
        ),
      ),
      commands,
    );

    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain("curl");
    expect(commands[0]).toContain("https://hooks.slack/x");
    expect(commands[1]).toContain("gh issue comment 42 --repo o/r --body-file");
    expect(commands[2]).toBe(
      "gh api repos/o/r/issues/42 -X PATCH -f state=closed",
    );
  });

  it("does not close the issue on a transient failure", async () => {
    const commands: string[] = [];
    await run(
      NotifierServiceTag.pipe(
        Effect.flatMap((n) => n.notifyFailure("boom", false)),
      ),
      commands,
    );

    expect(commands.some((c) => c.includes("state=closed"))).toBe(false);
    expect(commands[0]).toContain("gh issue comment 42 --repo o/r --body-file");
    expect(commands[commands.length - 1]).toContain("curl");
  });

  it("sends Slack confirmation before issue housekeeping for a saga update", async () => {
    const commands: string[] = [];
    await run(
      NotifierServiceTag.pipe(
        Effect.flatMap((n) =>
          n.notifySagaUpdate({
            saga: "heist",
            contribution: "The cats cancel the robbery.",
            updated: true,
          }),
        ),
      ),
      commands,
    );

    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain("curl");
    expect(commands[1]).toContain("gh issue comment 42 --repo o/r --body-file");
    expect(commands[2]).toContain("state=closed");
  });

  it("reports a failed saga update without closing the issue", async () => {
    const commands: string[] = [];
    await run(
      NotifierServiceTag.pipe(
        Effect.flatMap((n) =>
          n.notifySagaUpdate({
            saga: "heist",
            contribution: "The cats cancel the robbery.",
            updated: false,
          }),
        ),
      ),
      commands,
    );

    expect(commands).toHaveLength(2);
    expect(commands.some((command) => command.includes("state=closed"))).toBe(
      false,
    );
    expect(commands[0]).toContain("curl");
    expect(commands[1]).toContain("gh issue comment 42 --repo o/r --body-file");
  });

  it("closes the issue as not_planned on a moderation failure", async () => {
    const commands: string[] = [];
    await run(
      NotifierServiceTag.pipe(
        Effect.flatMap((n) => n.notifyFailure("blocked", true)),
      ),
      commands,
    );

    expect(commands).toContain(
      "gh api repos/o/r/issues/42 -X PATCH -f state=closed -f state_reason=not_planned",
    );
  });
});
