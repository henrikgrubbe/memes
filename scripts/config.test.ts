import { ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  AppConfigLayer,
  AppConfigService,
  IssueFields,
  parseIssueBody,
} from "./config.js";
import { failureOrThrow } from "./test-support.js";

const run = (body: string) =>
  Effect.runPromise(Effect.exit(parseIssueBody(body)));

describe("parseIssueBody", () => {
  it("parses all known fields", async () => {
    const body =
      "sender: hhb\nmessage: funny cat\nchannel: #memes\nlink: https://slack.com/x";
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toMatchObject({
        sender: "hhb",
        message: "funny cat",
        channel: "#memes",
        link: "https://slack.com/x",
      });
    }
  });

  it("handles multi-line message values", async () => {
    const body =
      "sender: hhb\nmessage: line one\n  continuation\nchannel: #general\nlink: https://x";
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.message).toBe("line one\n  continuation");
    }
  });

  it("keeps a colon-prefixed continuation line as part of the message (issue #614)", async () => {
    const body = [
      "Sender: U4TEZNWNN",
      "Channel: G01K33ZEMFT",
      "Message: Meme-maskinen: Fy føj Rune Sostack Clausen, dit meme var alt for beskidt!",
      "Rune: :sadpepe: :sad-cat-meow: :esben-sad:",
      "Link: https://bankdata.slack.com/archives/G01K33ZEMFT/p1787747639249749",
      "Timestamp: 1787747639.249749",
    ].join("\n");
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.message).toBe(
        "Meme-maskinen: Fy føj Rune Sostack Clausen, dit meme var alt for beskidt!\nRune: :sadpepe: :sad-cat-meow: :esben-sad:",
      );
      expect(exit.value.link).toBe(
        "https://bankdata.slack.com/archives/G01K33ZEMFT/p1787747639249749",
      );
    }
  });

  it("ignores unknown keys", async () => {
    const body =
      "sender: hhb\nrandom: ignored\nmessage: hi\nchannel: #c\nlink: https://x";
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(
        (exit.value as unknown as Record<string, unknown>)["random"],
      ).toBeUndefined();
    }
  });

  it("handles Windows-style CRLF line endings", async () => {
    const body = "sender: hhb\r\nmessage: hi\r\nchannel: #c\r\nlink: https://x";
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.sender).toBe("hhb");
      expect(exit.value.message).toBe("hi");
    }
  });

  it("fails with ParseError for empty body", async () => {
    const exit = await run("");
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("is case-insensitive for field names", async () => {
    const body = "Sender: hhb\nMESSAGE: hello\nChannel: #c\nLink: https://x";
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.sender).toBe("hhb");
      expect(exit.value.message).toBe("hello");
    }
  });

  it("preserves colons in values", async () => {
    const body =
      "sender: hhb\nmessage: time: 12:00\nchannel: #c\nlink: https://example.com/path?q=1";
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.message).toBe("time: 12:00");
      expect(exit.value.link).toBe("https://example.com/path?q=1");
    }
  });

  it("trims whitespace around field values", async () => {
    const body =
      "sender:   hhb   \nmessage:  hi  \nchannel: #c\nlink: https://x";
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.sender).toBe("hhb");
      expect(exit.value.message).toBe("hi");
    }
  });

  it("skips blank lines between fields without appending to previous", async () => {
    const body = "sender: hhb\n\nmessage: hi\nchannel: #c\nlink: https://x";
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.sender).toBe("hhb");
      expect(exit.value.message).toBe("hi");
    }
  });

  it("fails when a required field is missing", async () => {
    const body = "sender: hhb\nmessage: hi\nchannel: #c";
    const exit = await run(body);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureOrThrow(exit)._tag).toBe("ParseError");
  });

  it("fails when a field value is only whitespace", async () => {
    const body = "sender:   \nmessage: hi\nchannel: #c\nlink: https://x";
    const exit = await run(body);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("returns an IssueFields instance", async () => {
    const body = "sender: hhb\nmessage: hi\nchannel: #c\nlink: https://x";
    const exit = await run(body);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBeInstanceOf(IssueFields);
    }
  });
});

describe("AppConfigLayer", () => {
  it("parses saga directives from the issue message", async () => {
    const issueBody =
      "sender: hhb\nmessage: read:origin make a sequel write:next\nchannel: #memes\nlink: https://slack.com/x";
    const provider = ConfigProvider.fromMap(
      new Map([
        ["REPO", "henrikgrubbe/memes"],
        ["SLACK_WEBHOOK_URL", "https://slack.com/webhook"],
        ["ISSUE_NUMBER", "823"],
        ["ISSUE_BODY", issueBody],
      ]),
    );
    const config = await Effect.runPromise(
      AppConfigService.pipe(
        Effect.provide(AppConfigLayer),
        Effect.withConfigProvider(provider),
      ),
    );

    expect(config.memePrompt).toBe("make a sequel");
    expect(config.readSaga).toBe("origin");
    expect(config.writeSaga).toBe("next");
  });
});
