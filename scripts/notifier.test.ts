import {describe, expect, it} from "vitest";
import {buildFailureComment, buildSlackSuccessPayload, buildSuccessComment, formatCostCents} from "./notifier.js";

describe("buildSuccessComment", () => {
    it("includes repo-backed image links without crashing", () => {
        const comment = buildSuccessComment({
            memeId: "meme-123",
            provider: "xAI",
            history: [{provider: "xAI", status: "success"}],
            prompt: "make a meme",
            requester: "U123",
            channel: "#memes",
            slackLink: "https://slack.example/message",
            repo: "henrikgrubbe/memes",
        });

        expect(comment).toContain("https://github.com/henrikgrubbe/memes/blob/main/memes/meme-123.jpg");
        expect(comment).toContain("https://raw.githubusercontent.com/henrikgrubbe/memes/refs/heads/main/memes/meme-123.jpg");
    });

    it("renders revised prompt and usage metadata when present", () => {
        const comment = buildSuccessComment({
            memeId: "meme-123",
            provider: "OpenAI",
            history: [
                {provider: "xAI", status: "rate-limited"},
                {provider: "OpenAI", status: "success"},
            ],
            prompt: "make a meme",
            requester: "U123",
            channel: "#memes",
            slackLink: "https://slack.example/message",
            repo: "henrikgrubbe/memes",
            metadata: {
                revisedPrompt: "revised prompt text",
                usage: {inputTokens: 12, outputTokens: 34, totalTokens: 46},
                costCents: 0.108,
            },
        });

        expect(comment).toContain("**Revised prompt:** `revised prompt text`");
        expect(comment).toContain("**Usage:** 12 input, 34 output, 46 total tokens");
        expect(comment).toContain("**Estimated cost:** 0.108¢");
        expect(comment).toContain("- xAI ⏳ rate limited");
        expect(comment).toContain("- OpenAI ✅");
    });

    it("omits estimated cost when no usage metadata is available", () => {
        const comment = buildSuccessComment({
            memeId: "meme-456",
            provider: "xAI",
            history: [{provider: "xAI", status: "success"}],
            prompt: "make a meme",
            requester: "U456",
            channel: "#memes",
            slackLink: "https://slack.example/message",
            repo: "henrikgrubbe/memes",
        });

        expect(comment).not.toContain("**Estimated cost:**");
        expect(comment).not.toContain("**Usage:**");
    });
});

describe("buildFailureComment", () => {
    it("renders the error message without a provider list when no history is given", () => {
        const comment = buildFailureComment("grok-imagine-image is out of credits/quota: 403");
        expect(comment).toContain("❌ Meme generation failed.");
        expect(comment).toContain("grok-imagine-image is out of credits/quota: 403");
        expect(comment).not.toContain("**Provider attempts:**");
    });

    it("renders each attempt when history is provided (regression for #706)", () => {
        const comment = buildFailureComment("xAI (grok-imagine-image) is out of credits/quota: 403", [
            {provider: "OpenAI (gpt-image-2)", status: "failed", message: "blocked by moderation"},
            {provider: "grok-imagine-image", status: "failed", message: "out of credits"},
        ]);
        expect(comment).toContain("**Provider attempts:**");
        expect(comment).toContain("- OpenAI (gpt-image-2) ❌ (blocked by moderation)");
        expect(comment).toContain("- grok-imagine-image ❌ (out of credits)");
    });

    it("omits the provider list for an empty history", () => {
        const comment = buildFailureComment("some error", []);
        expect(comment).not.toContain("**Provider attempts:**");
    });
});

describe("formatCostCents", () => {
    it("returns null when cost is unknown", () => {
        expect(formatCostCents(undefined)).toBeNull();
        expect(formatCostCents({usage: {inputTokens: 12, outputTokens: 34, totalTokens: 46}})).toBeNull();
    });

    it("formats cost as a cents string with three decimals", () => {
        expect(formatCostCents({costCents: 0.108})).toBe("0.108¢");
    });
});

describe("buildSlackSuccessPayload", () => {
    const base = {
        memeId: "meme-123",
        provider: "OpenAI",
        title: "make a meme",
        requester: "U123",
        channel: "#memes",
        repo: "henrikgrubbe/memes",
    };

    it("includes a display-ready cost_cents string when cost is present", () => {
        const payload = buildSlackSuccessPayload({
            ...base,
            metadata: {usage: {inputTokens: 12, outputTokens: 34, totalTokens: 46}, costCents: 0.108},
        });
        expect(payload.status).toBe("success");
        expect(payload.provider).toBe("OpenAI");
        expect(payload.image_url).toBe("https://raw.githubusercontent.com/henrikgrubbe/memes/refs/heads/main/memes/meme-123.jpg");
        expect(payload.cost_cents).toBe("0.108¢");
    });

    it("omits cost_cents when cost is unavailable", () => {
        const payload = buildSlackSuccessPayload(base);
        expect(payload.cost_cents).toBeUndefined();
        expect("cost_cents" in payload).toBe(false);
    });
});
