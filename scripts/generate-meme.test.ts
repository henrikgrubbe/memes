import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AllProvidersExhaustedError,
  ModerationFailedError,
  ModerationBlockedError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "./errors.js";
import { generateImage } from "./generate-meme.js";
import { makeProvidersLayer, ProvidersServiceTag } from "./providers.js";
import type { ProviderFn } from "./providers.js";

// ---- Provider mock helpers ------------------------------------------------

const PRIMARY = "OpenAI";
const FALLBACK = "xAI";

const successFn =
  (provider = PRIMARY): ProviderFn =>
  () =>
    Effect.succeed({
      buffer: Buffer.from("hello"),
      history: [{ provider, status: "success" }],
    });
const successRlFn =
  (provider: string, hits: number): ProviderFn =>
  () =>
    Effect.succeed({
      buffer: Buffer.from("hello"),
      history: [
        ...Array.from(
          { length: hits },
          (): { provider: string; status: "rate-limited" } => ({
            provider,
            status: "rate-limited",
          }),
        ),
        { provider, status: "success" },
      ],
    });
const modFn =
  (provider: string): ProviderFn =>
  () =>
    Effect.fail(new ModerationBlockedError({ provider, detail: "blocked" }));
const rlFn =
  (provider: string): ProviderFn =>
  () =>
    Effect.fail(new RateLimitError({ provider, attempts: 10 }));
const errFn =
  (provider: string): ProviderFn =>
  () =>
    Effect.fail(new ProviderError({ provider, detail: "error" }));
const quotaFn =
  (provider: string): ProviderFn =>
  () =>
    Effect.fail(new QuotaExhaustedError({ provider, detail: "no credits" }));

const run = <A, E>(
  effect: Effect.Effect<A, E, ProvidersServiceTag>,
  layer: Layer.Layer<ProvidersServiceTag>,
) =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(effect.pipe(Effect.withRandomFixed([0])), layer),
    ),
  );

// ---- generateImage --------------------------------------------------------

describe("generateImage", () => {
  it("returns success with primary provider history", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: successFn() }),
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
      makeProvidersLayer({ [PRIMARY]: successRlFn(PRIMARY, 2) }),
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
      makeProvidersLayer({ [PRIMARY]: modFn(PRIMARY) }, successFn(FALLBACK)),
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
      makeProvidersLayer({ [PRIMARY]: modFn(PRIMARY) }, fallbackWithMeta),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.metadata).toEqual({ revisedPrompt: "revised" });
    }
  });

  it("fails with ModerationFailedError when both providers are blocked", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: modFn(PRIMARY) }, modFn(FALLBACK)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      expect(exit.cause.error).toBeInstanceOf(ModerationFailedError);
    }
  });

  it("fails with ModerationFailedError when blocked and no fallback is configured", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: modFn(PRIMARY) }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      expect(exit.cause.error).toBeInstanceOf(ModerationFailedError);
      // @ts-expect-error accessing .error on Cause.Fail
      expect(exit.cause.error.fallbackProvider).toBeNull();
      // @ts-expect-error accessing .error on Cause.Fail
      expect(exit.cause.error.message).toContain("blocked by moderation");
      // @ts-expect-error accessing .error on Cause.Fail
      expect(exit.cause.error.message).toContain(
        "no fallback provider available",
      );
    }
  });

  it("propagates RateLimitError from primary (not a moderation block)", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: rlFn(PRIMARY) }, successFn(FALLBACK)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      expect(exit.cause.error).toBeInstanceOf(RateLimitError);
      // @ts-expect-error accessing .error on Cause.Fail
      expect(exit.cause.error.history).toEqual([
        {
          provider: PRIMARY,
          status: "failed",
          message: `${PRIMARY} rate-limit retries exhausted after 10 attempts`,
        },
      ]);
    }
  });

  it("propagates ProviderError from primary (not a moderation block)", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: errFn(PRIMARY) }, successFn(FALLBACK)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      expect(exit.cause.error).toBeInstanceOf(ProviderError);
    }
  });

  it("fails with AllProvidersExhaustedError when the only primary is out of credits", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: quotaFn(PRIMARY) }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      expect(exit.cause.error).toBeInstanceOf(AllProvidersExhaustedError);
    }
  });

  it("skips an out-of-credits primary and uses the next available primary", async () => {
    const SECONDARY = "OpenAI-alt";
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({
        [PRIMARY]: quotaFn(PRIMARY),
        [SECONDARY]: successFn(SECONDARY),
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
      makeProvidersLayer({ [PRIMARY]: modFn(PRIMARY) }, quotaFn(FALLBACK)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      const error = exit.cause.error;
      expect(error).toBeInstanceOf(ModerationFailedError);
      // The headline is the primary moderation block, with the dead fallback
      // relegated to a parenthetical note.
      expect(error.provider).toBe(PRIMARY);
      expect(error.message).toContain("blocked by moderation");
      expect(error.message).toContain("out of credits/quota");
      expect(error.fallbackProvider).toBe(FALLBACK);
    }
  });

  // Regression for #706: a primary moderation block that diverts to a fallback
  // which is then out of credits must still report the primary attempt.
  it("carries the primary moderation attempt in history when the fallback is out of credits", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: modFn(PRIMARY) }, quotaFn(FALLBACK)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      const error = exit.cause.error;
      expect(error).toBeInstanceOf(ModerationFailedError);
      expect(error.history).toHaveLength(2);
      expect(error.history[0]).toMatchObject({
        provider: PRIMARY,
        status: "failed",
      });
      expect(error.history[1]).toMatchObject({
        provider: FALLBACK,
        status: "failed",
      });
    }
  });

  it("carries full history on ModerationFailedError when both providers are blocked", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: modFn(PRIMARY) }, modFn(FALLBACK)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      const error = exit.cause.error;
      expect(error).toBeInstanceOf(ModerationFailedError);
      expect(error.history).toHaveLength(2);
      expect(error.history[0]).toMatchObject({
        provider: PRIMARY,
        status: "failed",
      });
      expect(error.history[1]).toMatchObject({
        provider: FALLBACK,
        status: "failed",
      });
    }
  });

  it("carries the skipped primaries in history on AllProvidersExhaustedError", async () => {
    const SECONDARY = "OpenAI-alt";
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({
        [PRIMARY]: quotaFn(PRIMARY),
        [SECONDARY]: quotaFn(SECONDARY),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      const error = exit.cause.error;
      expect(error).toBeInstanceOf(AllProvidersExhaustedError);
      expect(error.history).toHaveLength(2);
      expect(
        error.history.every((e: { status: string }) => e.status === "failed"),
      ).toBe(true);
    }
  });

  it("carries the primary attempt in history on a propagated ProviderError", async () => {
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({ [PRIMARY]: errFn(PRIMARY) }, successFn(FALLBACK)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      const error = exit.cause.error;
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.history).toHaveLength(1);
      expect(error.history[0]).toMatchObject({
        provider: PRIMARY,
        status: "failed",
      });
    }
  });

  it("preserves skipped-primary history when a later primary fails", async () => {
    const SECONDARY = "OpenAI-alt";
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({
        [PRIMARY]: quotaFn(PRIMARY),
        [SECONDARY]: errFn(SECONDARY),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      const error = exit.cause.error;
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.history).toHaveLength(2);
      expect(error.history[0]).toMatchObject({
        provider: PRIMARY,
        status: "failed",
      });
      expect(error.history[1]).toMatchObject({
        provider: SECONDARY,
        status: "failed",
      });
    }
  });

  it("lists every exhausted primary in AllProvidersExhaustedError", async () => {
    const SECONDARY = "OpenAI-alt";
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer({
        [PRIMARY]: quotaFn(PRIMARY),
        [SECONDARY]: quotaFn(SECONDARY),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // @ts-expect-error accessing .error on Cause.Fail
      const error = exit.cause.error;
      expect(error).toBeInstanceOf(AllProvidersExhaustedError);
      expect([...error.providers].sort()).toEqual([PRIMARY, SECONDARY].sort());
    }
  });

  it("keeps a skipped-primary entry in history when a later primary triggers the moderation fallback", async () => {
    const SECONDARY = "OpenAI-alt";
    const exit = await run(
      generateImage("make a meme"),
      makeProvidersLayer(
        { [PRIMARY]: quotaFn(PRIMARY), [SECONDARY]: modFn(SECONDARY) },
        successFn(FALLBACK),
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
