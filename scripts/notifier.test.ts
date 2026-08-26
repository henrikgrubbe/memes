import {describe, expect, it} from "vitest";
import {buildSuccessComment} from "./notifier.js";

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
