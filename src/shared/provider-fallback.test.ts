import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { AllProvidersExhaustedError, ModerationFailedError } from "./errors.js";
import { generateWithFallback } from "./provider-fallback.js";
import {
  moderationBlockedProvider,
  providerErrorProvider,
  quotaExhaustedProvider,
  rateLimitedProvider,
  successfulProvider,
} from "./provider-test-support.js";
import { failureOfType, failureOrThrow } from "./test-support.js";

const primary = "OpenAI";
const fallback = "xAI";
const request = { prompt: "A cat on a bike", user: "U123" };

const run = (
  primaryProvider: ReturnType<typeof successfulProvider>,
  fallbackProvider: ReturnType<typeof successfulProvider> | null = null,
) =>
  Effect.runPromise(
    generateWithFallback(
      { [primary]: primaryProvider },
      { name: fallback, generate: fallbackProvider },
      request,
    ).pipe(Effect.exit),
  );

describe("generateWithFallback", () => {
  it("returns a successful primary result", async () => {
    const exit = await run(successfulProvider(primary));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.history).toEqual([
        { provider: primary, status: "success" },
      ]);
    }
  });

  it.each([
    [
      "provider error",
      providerErrorProvider(primary),
      "ProviderError",
      "failed",
    ],
    ["rate limit", rateLimitedProvider(primary), "RateLimitError", "failed"],
  ] as const)(
    "preserves attempt history for a %s",
    async (_name, provider, tag, status) => {
      const exit = await run(provider);
      const error = failureOrThrow(exit);

      expect(error._tag).toBe(tag);
      expect(error.history).toEqual([
        expect.objectContaining({ provider: primary, status }),
      ]);
    },
  );

  it("skips exhausted providers and reports that no primary remains", async () => {
    const exit = await run(quotaExhaustedProvider(primary));
    const error = failureOfType(exit, AllProvidersExhaustedError);

    expect(error.providers).toEqual([primary]);
    expect(error.history).toEqual([
      expect.objectContaining({ provider: primary, status: "failed" }),
    ]);
  });

  it("reports a moderation failure when no fallback is configured", async () => {
    const exit = await run(moderationBlockedProvider(primary));
    const error = failureOfType(exit, ModerationFailedError);

    expect(error.fallbackProvider).toBeNull();
    expect(error.history).toEqual([
      expect.objectContaining({ provider: primary, status: "failed" }),
    ]);
  });

  it("uses the fallback after a moderation block", async () => {
    const exit = await run(
      moderationBlockedProvider(primary),
      successfulProvider(fallback),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.history).toEqual([
        expect.objectContaining({ provider: primary, status: "failed" }),
        { provider: fallback, status: "success" },
      ]);
    }
  });

  it.each([
    [
      "moderation",
      moderationBlockedProvider(fallback),
      "also blocked by moderation",
    ],
    ["quota", quotaExhaustedProvider(fallback), "out of credits/quota"],
    [
      "rate limit",
      rateLimitedProvider(fallback),
      "rate-limit retries exhausted",
    ],
    ["provider error", providerErrorProvider(fallback), "error"],
  ] as const)(
    "reports a failed fallback after %s",
    async (_name, provider, detail) => {
      const exit = await run(moderationBlockedProvider(primary), provider);
      const error = failureOfType(exit, ModerationFailedError);

      expect(error.fallbackProvider).toBe(fallback);
      expect(error.fallbackDetail).toBe(detail);
      expect(error.history).toHaveLength(2);
    },
  );
});
