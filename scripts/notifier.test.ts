import {describe, expect, it} from "vitest";
import {buildSlackSuccessPayload, buildSuccessComment, estimateCostCents, formatCostCents} from "./notifier.js";

describe("buildSuccessComment", () => {
    it("embeds the provided image url without crashing", () => {
        const comment = buildSuccessComment({
            memeId: "meme-123",
            imageUrl: "https://github.com/henrikgrubbe/memes/releases/download/memes/meme-123.jpg",
            provider: "xAI",
            history: [{provider: "xAI", status: "success"}],
            prompt: "make a meme",
            requester: "U123",
            channel: "#memes",
            slackLink: "https://slack.example/message",
        });

        expect(comment).toContain("[meme-123.jpg](https://github.com/henrikgrubbe/memes/releases/download/memes/meme-123.jpg)");
        expect(comment).toContain("![Generated meme](https://github.com/henrikgrubbe/memes/releases/download/memes/meme-123.jpg)");
    });

    it("renders revised prompt and usage metadata when present", () => {
        const comment = buildSuccessComment({
            memeId: "meme-123",
            imageUrl: "https://github.com/henrikgrubbe/memes/releases/download/memes/meme-123.jpg",
            provider: "OpenAI",
            history: [
                {provider: "xAI", status: "rate-limited"},
                {provider: "OpenAI", status: "success"},
            ],
            prompt: "make a meme",
            requester: "U123",
            channel: "#memes",
            slackLink: "https://slack.example/message",
            metadata: {
                revisedPrompt: "revised prompt text",
                usage: {inputTokens: 12, outputTokens: 34, totalTokens: 46},
            },
        });

        expect(comment).toContain("**Revised prompt:** `revised prompt text`");
        expect(comment).toContain("**Usage:** 12 input, 34 output, 46 total tokens");
        // 12 * $5/M + 34 * $30/M = $0.00108 = 0.108¢
        expect(comment).toContain("**Estimated cost:** 0.108¢");
        expect(comment).toContain("- xAI ⏳ rate limited");
        expect(comment).toContain("- OpenAI ✅");
    });

    it("omits estimated cost when no usage metadata is available", () => {
        const comment = buildSuccessComment({
            memeId: "meme-456",
            imageUrl: "https://github.com/henrikgrubbe/memes/releases/download/memes/meme-456.jpg",
            provider: "xAI",
            history: [{provider: "xAI", status: "success"}],
            prompt: "make a meme",
            requester: "U456",
            channel: "#memes",
            slackLink: "https://slack.example/message",
        });

        expect(comment).not.toContain("**Estimated cost:**");
        expect(comment).not.toContain("**Usage:**");
    });
});

describe("estimateCostCents", () => {
    it("returns null when token usage is unknown", () => {
        expect(estimateCostCents(undefined)).toBeNull();
        expect(estimateCostCents({revisedPrompt: "x"})).toBeNull();
    });

    it("computes cost in cents from input/output token usage", () => {
        // 12 * $5/M + 34 * $30/M = $0.00108 = 0.108¢
        expect(estimateCostCents({usage: {inputTokens: 12, outputTokens: 34, totalTokens: 46}}))
            .toBeCloseTo(0.108, 6);
    });
});

describe("formatCostCents", () => {
    it("returns null when token usage is unknown", () => {
        expect(formatCostCents(undefined)).toBeNull();
    });

    it("formats cost as a cents string with three decimals", () => {
        expect(formatCostCents({usage: {inputTokens: 12, outputTokens: 34, totalTokens: 46}}))
            .toBe("0.108¢");
    });
});

describe("buildSlackSuccessPayload", () => {
    const base = {
        imageUrl: "https://github.com/henrikgrubbe/memes/releases/download/memes/meme-123.jpg",
        provider: "OpenAI",
        title: "make a meme",
        requester: "U123",
        channel: "#memes",
    };

    it("includes a display-ready cost_cents string when usage is present", () => {
        const payload = buildSlackSuccessPayload({
            ...base,
            metadata: {usage: {inputTokens: 12, outputTokens: 34, totalTokens: 46}},
        });
        expect(payload.status).toBe("success");
        expect(payload.provider).toBe("OpenAI");
        expect(payload.image_url).toBe("https://github.com/henrikgrubbe/memes/releases/download/memes/meme-123.jpg");
        expect(payload.cost_cents).toBe("0.108¢");
    });

    it("omits cost_cents when usage is unavailable", () => {
        const payload = buildSlackSuccessPayload(base);
        expect(payload.cost_cents).toBeUndefined();
        expect("cost_cents" in payload).toBe(false);
    });
});
