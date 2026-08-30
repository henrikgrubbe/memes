import { Effect } from "effect";
import {
  ModerationBlockedError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "./errors.js";
import type { ProviderFn } from "./providers.js";

export const PRIMARY = "OpenAI";
export const SECONDARY = "OpenAI-alt";
export const FALLBACK = "xAI";

export const successfulProvider =
  (provider = PRIMARY): ProviderFn =>
  () =>
    Effect.succeed({
      buffer: Buffer.from("hello"),
      history: [{ provider, status: "success" }],
    });

export const rateLimitedThenSuccessfulProvider =
  (provider: string, hits: number): ProviderFn =>
  () =>
    Effect.succeed({
      buffer: Buffer.from("hello"),
      history: [
        ...Array.from(
          { length: hits },
          (): {
            provider: string;
            status: "rate-limited";
          } => ({ provider, status: "rate-limited" }),
        ),
        { provider, status: "success" },
      ],
    });

export const moderationBlockedProvider =
  (provider: string): ProviderFn =>
  () =>
    Effect.fail(new ModerationBlockedError({ provider, detail: "blocked" }));

export const rateLimitedProvider =
  (provider: string): ProviderFn =>
  () =>
    Effect.fail(new RateLimitError({ provider, attempts: 10 }));

export const providerErrorProvider =
  (provider: string): ProviderFn =>
  () =>
    Effect.fail(new ProviderError({ provider, detail: "error" }));

export const quotaExhaustedProvider =
  (provider: string): ProviderFn =>
  () =>
    Effect.fail(new QuotaExhaustedError({ provider, detail: "no credits" }));

export const providerFailingWith =
  (error: ProviderError | RateLimitError | QuotaExhaustedError): ProviderFn =>
  () =>
    Effect.fail(error);
