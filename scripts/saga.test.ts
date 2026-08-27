import {describe, expect, it} from "vitest";
import {
    appendFallback,
    buildCompressionMessages,
    buildMemePrompt,
    capCanon,
    MAX_CANON_CHARS,
    MAX_PROMPT_CHARS,
    sagaPath,
} from "./saga.js";

describe("buildMemePrompt", () => {
    it("wraps a bare prompt when no saga canon is supplied", () => {
        expect(buildMemePrompt("a cat on a bike")).toBe("Make a meme: a cat on a bike.");
    });

    it("ignores an empty canon", () => {
        expect(buildMemePrompt("a cat", {name: "heist", canon: "   "})).toBe("Make a meme: a cat.");
    });

    it("prepends the canon for continuity and keeps the meme instruction", () => {
        const prompt = buildMemePrompt("the getaway", {name: "heist", canon: "A gang of cats robs a bank."});
        expect(prompt).toContain('Continuing the "heist" saga.');
        expect(prompt).toContain("A gang of cats robs a bank.");
        expect(prompt.endsWith("Make a meme: the getaway.")).toBe(true);
    });

    it("never exceeds the prompt cap, trimming the canon to fit", () => {
        const canon  = "x".repeat(MAX_CANON_CHARS);
        const prompt = buildMemePrompt("short prompt", {name: "s", canon});
        expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
        expect(prompt.endsWith("Make a meme: short prompt.")).toBe(true);
    });

    it("drops the canon entirely when the prompt alone fills the budget", () => {
        const longPrompt = "y".repeat(MAX_PROMPT_CHARS);
        const prompt     = buildMemePrompt(longPrompt, {name: "s", canon: "some canon"});
        expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
        expect(prompt).not.toContain("some canon");
    });
});

describe("capCanon", () => {
    it("leaves short canon untouched", () => {
        expect(capCanon("hello")).toBe("hello");
    });

    it("truncates canon longer than the ceiling", () => {
        expect(capCanon("z".repeat(MAX_CANON_CHARS + 500)).length).toBe(MAX_CANON_CHARS);
    });
});

describe("appendFallback", () => {
    it("starts a fresh list from an empty canon", () => {
        expect(appendFallback("", "first idea")).toBe("- first idea");
    });

    it("appends a new bullet to an existing canon", () => {
        expect(appendFallback("- older", "newer")).toBe("- older\n- newer");
    });

    it("caps the result at the ceiling", () => {
        expect(appendFallback("a".repeat(MAX_CANON_CHARS), "overflow").length).toBe(MAX_CANON_CHARS);
    });
});

describe("buildCompressionMessages", () => {
    it("names the saga and the character ceiling in the system prompt", () => {
        const [system] = buildCompressionMessages("heist", "canon", "idea");
        expect(system.role).toBe("system");
        expect(system.content).toContain('saga "heist"');
        expect(system.content).toContain(String(MAX_CANON_CHARS));
    });

    it("marks an empty canon as the first entry and includes the new idea", () => {
        const [, user] = buildCompressionMessages("heist", "   ", "a cat cracks a safe");
        expect(user.content).toContain("(empty - this is the first entry)");
        expect(user.content).toContain("a cat cracks a safe");
    });

    it("includes the existing canon when present", () => {
        const [, user] = buildCompressionMessages("heist", "prior canon text", "next");
        expect(user.content).toContain("prior canon text");
    });
});

describe("sagaPath", () => {
    it("maps a saga name to a markdown file under the context dir", () => {
        expect(sagaPath("heist")).toBe("context/heist.md");
    });
});
