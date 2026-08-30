import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AllProvidersExhaustedError,
  ModerationFailedError,
  ProviderError,
  RateLimitError,
} from "./errors.js";
import { generateImage } from "./generate-meme.js";
import {
  FALLBACK,
  moderationBlockedProvider,
  PRIMARY,
  providerErrorProvider,
  quotaExhaustedProvider,
  rateLimitedProvider,
  rateLimitedThenSuccessfulProvider,
  SECONDARY,
  successfulProvider,
} from "./provider-test-support.js";
import { makeProvidersLayer, ProvidersServiceTag } from "./providers.js";
import type { ProviderFn } from "./providers.js";
import { failureOfType } from "./test-support.js";

const run = <A, E>(
  effect: Effect.Effect<A, E, ProvidersServiceTag>,
  layer: Layer.Layer<ProvidersServiceTag>,
) =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(effect.pipe(Effect.withRandomFixed([0])), layer),
    ),
  );

describe("generateImage", () => {
  it("returns success with primary provider history", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: successfulProvider() }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const { history } = exit.value;
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual({ provider: PRIMARY, status: "success" });
    }
  });

  it("records rate-limit hits in history when primary succeeds after rate limits", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({
        [PRIMARY]: rateLimitedThenSuccessfulProvider(PRIMARY, 2),
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const { history } = exit.value;
      expect(history).toHaveLength(3); // 2 rate-limited + 1 success
      expect(history.filter((e) => e.status === "rate-limited")).toHaveLength(
        2,
      );
      expect(history.at(-1)?.status).toBe("success");
    }
  });

  it("falls back to fallback provider on moderation block", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: moderationBlockedProvider(PRIMARY) },
        successfulProvider(FALLBACK),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const { history } = exit.value;
      expect(history[0]).toMatchObject({ provider: PRIMARY, status: "failed" });
      expect(history.at(-1)).toMatchObject({
        provider: FALLBACK,
        status: "success",
      });
    }
  });

  it("preserves metadata from the fallback provider", async () => {
    const fallbackWithMeta: ProviderFn = () =>
      Effect.succeed({
        buffer: Buffer.from("hello"),
        history: [{ provider: FALLBACK, status: "success" }],
        metadata: { revisedPrompt: "revised" },
      });
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: moderationBlockedProvider(PRIMARY) },
        fallbackWithMeta,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.metadata).toEqual({ revisedPrompt: "revised" });
    }
  });

  it("fails with ModerationFailedError when both providers are blocked", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: moderationBlockedProvider(PRIMARY) },
        moderationBlockedProvider(FALLBACK),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    failureOfType(exit, ModerationFailedError);
  });

  it("fails with ModerationFailedError when blocked and no fallback is configured", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: moderationBlockedProvider(PRIMARY) }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, ModerationFailedError);
    expect(error.fallbackProvider).toBeNull();
    expect(error.message).toContain("blocked by moderation");
    expect(error.message).toContain("no fallback provider available");
  });

  it("propagates RateLimitError from primary (not a moderation block)", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: rateLimitedProvider(PRIMARY) },
        successfulProvider(FALLBACK),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, RateLimitError);
    expect(error.history).toEqual([
      {
        provider: PRIMARY,
        status: "failed",
        message: `${PRIMARY} rate-limit retries exhausted after 10 attempts`,
      },
    ]);
  });

  it("propagates ProviderError from primary (not a moderation block)", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: providerErrorProvider(PRIMARY) },
        successfulProvider(FALLBACK),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    failureOfType(exit, ProviderError);
  });

  it("fails with AllProvidersExhaustedError when the only primary is out of credits", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: quotaExhaustedProvider(PRIMARY) }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    failureOfType(exit, AllProvidersExhaustedError);
  });

  it("skips an out-of-credits primary and uses the next available primary", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({
        [PRIMARY]: quotaExhaustedProvider(PRIMARY),
        [SECONDARY]: successfulProvider(SECONDARY),
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const { history } = exit.value;
      expect(history[0]).toMatchObject({ provider: PRIMARY, status: "failed" });
      expect(history.at(-1)).toMatchObject({
        provider: SECONDARY,
        status: "success",
      });
    }
  });

  it("surfaces the moderation reason (not the fallback's error) when the fallback is out of credits", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: moderationBlockedProvider(PRIMARY) },
        quotaExhaustedProvider(FALLBACK),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, ModerationFailedError);
    // The headline is the primary moderation block, with the dead fallback
    // relegated to a parenthetical note.
    expect(error.provider).toBe(PRIMARY);
    expect(error.message).toContain("blocked by moderation");
    expect(error.message).toContain("out of credits/quota");
    expect(error.fallbackProvider).toBe(FALLBACK);
  });

  it("reports exhausted rate-limit retries from the moderation fallback", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: moderationBlockedProvider(PRIMARY) },
        rateLimitedProvider(FALLBACK),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, ModerationFailedError);
    expect(error.fallbackProvider).toBe(FALLBACK);
    expect(error.fallbackDetail).toBe("rate-limit retries exhausted");
    expect(error.history).toHaveLength(2);
  });

  // Regression for #706: a primary moderation block that diverts to a fallback
  // which is then out of credits must still report the primary attempt.
  it("carries the primary moderation attempt in history when the fallback is out of credits", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: moderationBlockedProvider(PRIMARY) },
        quotaExhaustedProvider(FALLBACK),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, ModerationFailedError);
    const history = error.history ?? [];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      provider: PRIMARY,
      status: "failed",
    });
    expect(history[1]).toMatchObject({
      provider: FALLBACK,
      status: "failed",
    });
  });

  it("carries full history on ModerationFailedError when both providers are blocked", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: moderationBlockedProvider(PRIMARY) },
        moderationBlockedProvider(FALLBACK),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, ModerationFailedError);
    const history = error.history ?? [];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      provider: PRIMARY,
      status: "failed",
    });
    expect(history[1]).toMatchObject({
      provider: FALLBACK,
      status: "failed",
    });
  });

  it("carries the skipped primaries in history on AllProvidersExhaustedError", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({
        [PRIMARY]: quotaExhaustedProvider(PRIMARY),
        [SECONDARY]: quotaExhaustedProvider(SECONDARY),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, AllProvidersExhaustedError);
    const history = error.history ?? [];
    expect(history).toHaveLength(2);
    expect(history.every((entry) => entry.status === "failed")).toBe(true);
  });

  it("carries the primary attempt in history on a propagated ProviderError", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: providerErrorProvider(PRIMARY) },
        successfulProvider(FALLBACK),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, ProviderError);
    const history = error.history ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      provider: PRIMARY,
      status: "failed",
    });
  });

  it("preserves skipped-primary history when a later primary fails", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({
        [PRIMARY]: quotaExhaustedProvider(PRIMARY),
        [SECONDARY]: providerErrorProvider(SECONDARY),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, ProviderError);
    const history = error.history ?? [];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      provider: PRIMARY,
      status: "failed",
    });
    expect(history[1]).toMatchObject({
      provider: SECONDARY,
      status: "failed",
    });
  });

  it("lists every exhausted primary in AllProvidersExhaustedError", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({
        [PRIMARY]: quotaExhaustedProvider(PRIMARY),
        [SECONDARY]: quotaExhaustedProvider(SECONDARY),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOfType(exit, AllProvidersExhaustedError);
    expect([...error.providers].sort()).toEqual([PRIMARY, SECONDARY].sort());
  });

  it("keeps a skipped-primary entry in history when a later primary triggers the moderation fallback", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        {
          [PRIMARY]: quotaExhaustedProvider(PRIMARY),
          [SECONDARY]: moderationBlockedProvider(SECONDARY),
        },
        successfulProvider(FALLBACK),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const { history } = exit.value;
      expect(history[0]).toMatchObject({ provider: PRIMARY, status: "failed" }); // out of credits, skipped
      expect(history[1]).toMatchObject({
        provider: SECONDARY,
        status: "failed",
      }); // moderation blocked
      expect(history.at(-1)).toMatchObject({
        provider: FALLBACK,
        status: "success",
      });
    }
  });
});
