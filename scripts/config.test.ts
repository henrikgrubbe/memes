import {Effect, Exit} from "effect";
import {describe, expect, it} from "vitest";
import {extractSagaDirectives, IssueFields, parseIssueBody} from "./config.js";

const run = (body: string) => Effect.runPromise(Effect.exit(parseIssueBody(body)));

describe("parseIssueBody", () => {
    it("parses all known fields", async () => {
        const body = "sender: hhb\nmessage: funny cat\nchannel: #memes\nlink: https://slack.com/x";
        const exit = await run(body);
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            expect(exit.value).toMatchObject({sender: "hhb", message: "funny cat", channel: "#memes", link: "https://slack.com/x"});
        }
    });

    it("handles multi-line message values", async () => {
        const body = "sender: hhb\nmessage: line one\n  continuation\nchannel: #general\nlink: https://x";
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
            expect(exit.value.link).toBe("https://bankdata.slack.com/archives/G01K33ZEMFT/p1787747639249749");
        }
    });

    it("ignores unknown keys", async () => {
        const body = "sender: hhb\nrandom: ignored\nmessage: hi\nchannel: #c\nlink: https://x";
        const exit = await run(body);
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            expect((exit.value as unknown as Record<string, unknown>)["random"]).toBeUndefined();
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
        const body = "sender: hhb\nmessage: time: 12:00\nchannel: #c\nlink: https://example.com/path?q=1";
        const exit = await run(body);
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            expect(exit.value.message).toBe("time: 12:00");
            expect(exit.value.link).toBe("https://example.com/path?q=1");
        }
    });

    it("trims whitespace around field values", async () => {
        const body = "sender:   hhb   \nmessage:  hi  \nchannel: #c\nlink: https://x";
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
        if (Exit.isFailure(exit)) {
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error._tag).toBe("ParseError");
        }
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

describe("extractSagaDirectives", () => {
    it("returns no sagas and the untouched prompt when there are no directives", () => {
        const r = extractSagaDirectives("a cat riding a bike");
        expect(r).toEqual({readSaga: null, writeSaga: null, prompt: "a cat riding a bike"});
    });

    it("extracts read and write sagas and strips the tokens from the prompt", () => {
        const r = extractSagaDirectives("read:heist a cat cracks a safe write:heist");
        expect(r.readSaga).toBe("heist");
        expect(r.writeSaga).toBe("heist");
        expect(r.prompt).toBe("a cat cracks a safe");
    });

    it("lower-cases saga names and is case-insensitive on the keyword", () => {
        const r = extractSagaDirectives("READ:StarWars luke as a cat");
        expect(r.readSaga).toBe("starwars");
        expect(r.writeSaga).toBeNull();
        expect(r.prompt).toBe("luke as a cat");
    });

    it("allows reading one saga while contributing to another", () => {
        const r = extractSagaDirectives("write:sequel read:origin a plot twist");
        expect(r.readSaga).toBe("origin");
        expect(r.writeSaga).toBe("sequel");
        expect(r.prompt).toBe("a plot twist");
    });

    it("keeps the first directive of each kind when several are present", () => {
        const r = extractSagaDirectives("read:one read:two write:a write:b hello");
        expect(r.readSaga).toBe("one");
        expect(r.writeSaga).toBe("a");
        expect(r.prompt).toBe("hello");
    });

    it("does not treat 'read: the news' (space after colon) as a directive", () => {
        const r = extractSagaDirectives("read: the news headline");
        expect(r.readSaga).toBeNull();
        expect(r.prompt).toBe("read: the news headline");
    });

    it("accepts slug names with digits, dashes and underscores", () => {
        const r = extractSagaDirectives("write:saga_2-b something");
        expect(r.writeSaga).toBe("saga_2-b");
        expect(r.prompt).toBe("something");
    });

    it("falls back to the original message when stripping empties the prompt", () => {
        const r = extractSagaDirectives("read:heist write:heist");
        expect(r.readSaga).toBe("heist");
        expect(r.writeSaga).toBe("heist");
        expect(r.prompt).toBe("read:heist write:heist");
    });
});
