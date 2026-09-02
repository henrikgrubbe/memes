import { describe, expect, it } from "vitest";
import {
  formatCostCents,
  formatFailureComment,
  formatSagaUpdateComment,
  formatSlackFailurePayload,
  formatSlackSagaUpdatePayload,
  formatSlackSuccessPayload,
  formatSuccessComment,
} from "./notification-format.js";

describe("formatSuccessComment", () => {
  it("includes repo-backed image links without crashing", () => {
    const comment = formatSuccessComment({
      memeId: "meme-123",
      provider: "xAI",
      history: [{ provider: "xAI", status: "success" }],
      prompt: "make a meme",
      requester: "U123",
      channel: "#memes",
      slackLink: "https://slack.example/message",
      repo: "henrikgrubbe/memes",
    });

    expect(comment).toContain(
      "https://github.com/henrikgrubbe/memes/blob/main/memes/meme-123.jpg",
    );
    expect(comment).toContain(
      "https://raw.githubusercontent.com/henrikgrubbe/memes/refs/heads/main/memes/meme-123.jpg",
    );
  });

  it("renders revised prompt and usage metadata when present", () => {
    const comment = formatSuccessComment({
      memeId: "meme-123",
      provider: "OpenAI",
      history: [
        { provider: "xAI", status: "rate-limited" },
        { provider: "OpenAI", status: "success" },
      ],
      prompt: "make a meme",
      requester: "U123",
      channel: "#memes",
      slackLink: "https://slack.example/message",
      repo: "henrikgrubbe/memes",
      metadata: {
        revisedPrompt: "revised prompt text",
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
        costCents: 0.108,
      },
    });

    expect(comment).toContain("**Revised prompt:** `revised prompt text`");
    expect(comment).toContain(
      "**Usage:** 12 input, 34 output, 46 total tokens",
    );
    expect(comment).toContain("**Estimated cost:** 0.108¢");
    expect(comment).toContain("- xAI ⏳ rate limited");
    expect(comment).toContain("- OpenAI ✅");
  });

  it("omits estimated cost when no usage metadata is available", () => {
    const comment = formatSuccessComment({
      memeId: "meme-456",
      provider: "xAI",
      history: [{ provider: "xAI", status: "success" }],
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

describe("formatFailureComment", () => {
  it("renders the error message without a provider list when no history is given", () => {
    const comment = formatFailureComment(
      "grok-imagine-image is out of credits/quota: 403",
    );
    expect(comment).toContain("❌ Meme generation failed.");
    expect(comment).toContain(
      "grok-imagine-image is out of credits/quota: 403",
    );
    expect(comment).not.toContain("**Provider attempts:**");
  });

  describe("formatSagaUpdateComment", () => {
    it("confirms a successful contribution", () => {
      expect(
        formatSagaUpdateComment({
          saga: "heist",
          contribution: "The cats cancel the robbery.",
          updated: true,
        }),
      ).toContain("✅ Saga `heist` updated.");
    });

    it("keeps the issue open when the contribution could not be stored", () => {
      expect(
        formatSagaUpdateComment({
          saga: "heist",
          contribution: "The cats cancel the robbery.",
          updated: false,
        }),
      ).toContain("The issue remains open.");
    });
  });

  it("renders each attempt when history is provided (regression for #706)", () => {
    const comment = formatFailureComment(
      "xAI (grok-imagine-image) is out of credits/quota: 403",
      [
        {
          provider: "OpenAI (gpt-image-2)",
          status: "failed",
          message: "blocked by moderation",
        },
        {
          provider: "grok-imagine-image",
          status: "failed",
          message: "out of credits",
        },
      ],
    );
    expect(comment).toContain("**Provider attempts:**");
    expect(comment).toContain(
      "- OpenAI (gpt-image-2) ❌ (blocked by moderation)",
    );
    expect(comment).toContain("- grok-imagine-image ❌ (out of credits)");
  });

  it("omits the provider list for an empty history", () => {
    const comment = formatFailureComment("some error", []);
    expect(comment).not.toContain("**Provider attempts:**");
  });
});

describe("formatCostCents", () => {
  it("returns null when cost is unknown", () => {
    expect(formatCostCents(undefined)).toBeNull();
    expect(
      formatCostCents({
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
      }),
    ).toBeNull();
  });

  it("formats cost as a cents string with three decimals", () => {
    expect(formatCostCents({ costCents: 0.108 })).toBe("0.108¢");
  });
});

describe("formatSlackSuccessPayload", () => {
  const base = {
    memeId: "meme-123",
    provider: "OpenAI",
    title: "make a meme",
    requester: "U123",
    channel: "#memes",
    repo: "henrikgrubbe/memes",
  };

  it("includes a display-ready cost_cents string when cost is present", () => {
    const payload = formatSlackSuccessPayload({
      ...base,
      metadata: {
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
        costCents: 0.108,
      },
    });
    expect(payload.status).toBe("success");
    expect(payload.provider).toBe("OpenAI");
    expect(payload.content_url).toBe(
      "https://raw.githubusercontent.com/henrikgrubbe/memes/refs/heads/main/memes/meme-123.jpg",
    );
    expect(payload.cost_cents).toBe("0.108¢");
  });

  it("omits cost_cents when cost is unavailable", () => {
    const payload = formatSlackSuccessPayload(base);
    expect(payload.cost_cents).toBeUndefined();
    expect("cost_cents" in payload).toBe(false);
  });
});

describe("formatSlackFailurePayload", () => {
  it("includes the generation error without success-only fields", () => {
    const payload = formatSlackFailurePayload({
      title: "make a meme",
      requester: "U123",
      channel: "#memes",
      error: "generation failed",
    });

    expect(payload).toEqual({
      status: "failure",
      content_url: "",
      title: "make a meme",
      requester: "U123",
      channel: "#memes",
      error: "generation failed",
    });
  });
});

describe("formatSlackSagaUpdatePayload", () => {
  it("formats a successful saga update without an image", () => {
    expect(
      formatSlackSagaUpdatePayload({
        saga: "heist",
        contribution: "The cats cancel the robbery.",
        updated: true,
        requester: "U123",
        channel: "#memes",
        repo: "henrikgrubbe/memes",
      }),
    ).toEqual({
      status: "saga-updated",
      content_url:
        "https://github.com/henrikgrubbe/memes/blob/main/context/heist.md",
      title: 'Saga "heist": The cats cancel the robbery.',
      requester: "U123",
      channel: "#memes",
      error: "",
    });
  });

  it("uses a distinct failure status when the saga update does not land", () => {
    const payload = formatSlackSagaUpdatePayload({
      saga: "heist",
      contribution: "The cats cancel the robbery.",
      updated: false,
      requester: "U123",
      channel: "#memes",
      repo: "henrikgrubbe/memes",
    });

    expect(payload.status).toBe("saga-update-failed");
    expect(payload.content_url).toBe("");
  });
});
