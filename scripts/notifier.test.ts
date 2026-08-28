import {describe, expect, it} from "vitest";
import {Effect, Layer} from "effect";
import {NotifierServiceTag, NotifierLayer} from "./notifier.js";
import {AppConfigService, type AppConfig} from "./config.js";
import {makeShellLayer, type Shell} from "./shell.js";

describe("NotifierService through the Shell seam", () => {
    const config: AppConfig = {
        issueNumber: "42", repo: "o/r", slackWebhookUrl: "https://hooks.slack/x", requester: "U1",
        memePrompt: "make a meme", channel: "#memes", slackLink: "https://slack/msg", readSaga: null, writeSaga: null,
    };

    // In-memory Shell recorder: captures the commands it's asked to run in order.
    const recordingShell = (commands: string[]): Shell => ({
        run: (command) => Effect.sync(() => {
            commands.push(command);
            return "";
        }),
        runWithBodyFile: (_ext, _content, command) => Effect.sync(() => {
            commands.push(command("/tmp/body"));
            return "";
        }),
    });

    const run = (effect: Effect.Effect<void, never, NotifierServiceTag>, commands: string[]) => {
        const layer = NotifierLayer.pipe(Layer.provide(Layer.mergeAll(
            makeShellLayer(recordingShell(commands)),
            Layer.succeed(AppConfigService, config),
        )));
        return Effect.runPromise(effect.pipe(Effect.provide(layer)));
    };

    it("posts a comment, closes the issue, then posts to Slack on success", async () => {
        const commands: string[] = [];
        await run(
            NotifierServiceTag.pipe(Effect.flatMap((n) => n.notifySuccess({
                memeId: "meme-1",
                history: [{provider: "OpenAI", status: "success"}],
                prompt: "make a meme",
            }))),
            commands,
        );

        expect(commands).toHaveLength(3);
        expect(commands[0]).toContain("gh issue comment 42 --repo o/r --body-file");
        expect(commands[1]).toBe("gh api repos/o/r/issues/42 -X PATCH -f state=closed");
        expect(commands[2]).toContain("curl");
        expect(commands[2]).toContain("https://hooks.slack/x");
        // The issue must be closed before we announce success to Slack.
        expect(commands.indexOf("gh api repos/o/r/issues/42 -X PATCH -f state=closed"))
            .toBeLessThan(commands.findIndex((c) => c.includes("curl")));
    });

    it("does not close the issue on a transient failure", async () => {
        const commands: string[] = [];
        await run(
            NotifierServiceTag.pipe(Effect.flatMap((n) => n.notifyFailure("boom", false))),
            commands,
        );

        expect(commands.some((c) => c.includes("state=closed"))).toBe(false);
        expect(commands[0]).toContain("gh issue comment 42 --repo o/r --body-file");
        expect(commands[commands.length - 1]).toContain("curl");
    });

    it("closes the issue as not_planned on a moderation failure", async () => {
        const commands: string[] = [];
        await run(
            NotifierServiceTag.pipe(Effect.flatMap((n) => n.notifyFailure("blocked", true))),
            commands,
        );

        expect(commands).toContain("gh api repos/o/r/issues/42 -X PATCH -f state=closed -f state_reason=not_planned");
    });
});
