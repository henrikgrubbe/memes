import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AllProvidersExhaustedError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "../shared/errors.js";
import { generateImage } from "./generate-meme.js";
import type { HistoryEntry } from "../shared/history.js";
import {
  PRIMARY,
  providerFailingWith,
  SECONDARY,
} from "../shared/provider-test-support.js";
import {
  makeProvidersLayer,
  ProvidersServiceTag,
} from "../shared/providers.js";

const generateFailure = (layer: Layer.Layer<ProvidersServiceTag>) =>
  Effect.runPromise(
    generateImage("make a meme").pipe(
      Effect.flip,
      Effect.withRandomFixed([0]),
      Effect.provide(layer),
    ),
  );

describe("provider error history", () => {
  it("reconstructs ProviderError with the failed attempt", async () => {
    const error = await generateFailure(
      makeProvidersLayer({
        [PRIMARY]: providerFailingWith(
          new ProviderError({ provider: PRIMARY, detail: "unavailable" }),
        ),
      }),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.history).toEqual([
      {
        provider: PRIMARY,
        status: "failed",
        message: `${PRIMARY} failed: unavailable`,
      },
    ]);
  });

  it("reconstructs RateLimitError with the failed attempt", async () => {
    const error = await generateFailure(
      makeProvidersLayer({
        [PRIMARY]: providerFailingWith(
          new RateLimitError({ provider: PRIMARY, attempts: 10 }),
        ),
      }),
    );

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.history).toEqual([
      {
        provider: PRIMARY,
        status: "failed",
        message: `${PRIMARY} rate-limit retries exhausted after 10 attempts`,
      },
    ]);
  });

  it("preserves history already attached to an error", async () => {
    const attached: HistoryEntry[] = [
      { provider: PRIMARY, status: "rate-limited" },
    ];
    const error = await generateFailure(
      makeProvidersLayer({
        [PRIMARY]: providerFailingWith(
          new ProviderError({
            provider: PRIMARY,
            detail: "unavailable",
            history: attached,
          }),
        ),
      }),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.history).toEqual([
      {
        provider: PRIMARY,
        status: "failed",
        message: `${PRIMARY} failed: unavailable`,
      },
      ...attached,
    ]);
  });

  it("reconstructs QuotaExhaustedError before reporting all primaries exhausted", async () => {
    const error = await generateFailure(
      makeProvidersLayer({
        [PRIMARY]: providerFailingWith(
          new QuotaExhaustedError({ provider: PRIMARY, detail: "no credits" }),
        ),
      }),
    );

    expect(error).toBeInstanceOf(AllProvidersExhaustedError);
    expect(error.history).toEqual([
      {
        provider: PRIMARY,
        status: "failed",
        message: `${PRIMARY} is out of credits/quota: no credits`,
      },
    ]);
  });

  it("keeps skipped-primary history before the terminal attempt", async () => {
    const error = await generateFailure(
      makeProvidersLayer({
        [PRIMARY]: providerFailingWith(
          new QuotaExhaustedError({ provider: PRIMARY, detail: "no credits" }),
        ),
        [SECONDARY]: providerFailingWith(
          new ProviderError({ provider: SECONDARY, detail: "unavailable" }),
        ),
      }),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.history).toEqual([
      {
        provider: PRIMARY,
        status: "failed",
        message: `${PRIMARY} is out of credits/quota: no credits`,
      },
      {
        provider: SECONDARY,
        status: "failed",
        message: `${SECONDARY} failed: unavailable`,
      },
    ]);
  });
});
