import OpenAI from "openai";
import { Duration, Effect, Ref, Schedule } from "effect";
import {
  ModerationBlockedError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "./errors.js";
import type { HistoryEntry } from "./history.js";
import {
  computeCostCents,
  type GenerationResult,
  type ModelPricing,
} from "./provider-model.js";

export const MAX_RETRIES = 10;
const RETRY_DELAY_PADDING_MS = 1_000;

class RateLimitRetryableError {
  public readonly _tag = "RateLimitRetryableError";

  public constructor(public readonly delayMs: number) {}
}

type CallError =
  | ModerationBlockedError
  | RateLimitRetryableError
  | ProviderError
  | QuotaExhaustedError;

interface ApiError {
  readonly status?: number;
  readonly message?: string;
  readonly headers?: Headers | Readonly<Record<string, string>>;
  readonly error?: {
    readonly code?: string;
    readonly moderation_details?: {
      readonly moderation_stage: string;
      readonly categories?: ReadonlyArray<string>;
    };
  };
}

function isQuotaExhausted(error: ApiError | null | undefined): boolean {
  const code = error?.error?.code;
  return (
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    (error?.status === 403 &&
      /credit|spending limit|quota|billing/i.test(error.message ?? ""))
  );
}

function parseRetryDelayMs(error: ApiError): number | null {
  const retryAfter =
    error.headers instanceof Headers
      ? error.headers.get("retry-after")
      : error.headers?.["retry-after"];
  const fromHeader = parseInt(retryAfter ?? "", 10);
  if (!isNaN(fromHeader)) {
    return fromHeader * 1000 + RETRY_DELAY_PADDING_MS;
  }

  const match = (error.message ?? "").match(/try again in (\d+(?:\.\d+)?)s/i);
  return match == null
    ? null
    : parseFloat(match[1]) * 1000 + RETRY_DELAY_PADDING_MS;
}

function classifyApiError(error: unknown, model: string): CallError {
  const apiError = error as ApiError | null | undefined;
  if (apiError?.error?.code === "moderation_blocked") {
    const details = apiError.error.moderation_details;
    const extra =
      details == null
        ? ""
        : `\nModeration stage: ${details.moderation_stage}\nCategories: ${(details.categories ?? []).join(", ")}`;
    return new ModerationBlockedError({
      provider: model,
      detail: (apiError.message ?? String(error)) + extra,
    });
  }
  if (isQuotaExhausted(apiError)) {
    return new QuotaExhaustedError({
      provider: model,
      detail: apiError?.message ?? String(error),
    });
  }
  if (apiError?.status === 429) {
    const delayMs = parseRetryDelayMs(apiError);
    if (delayMs != null) {
      return new RateLimitRetryableError(delayMs);
    }
  }
  return new ProviderError({
    provider: model,
    detail: apiError?.message ?? String(error),
  });
}

export function callWithRetry(
  providerName: string,
  client: OpenAI,
  model: string,
  params: Readonly<Record<string, string | number>>,
  prompt: string,
  user?: string,
  pricing?: ModelPricing,
): Effect.Effect<
  GenerationResult,
  ModerationBlockedError | RateLimitError | ProviderError | QuotaExhaustedError
> {
  return Effect.gen(function* () {
    const rateLimitHitsRef = yield* Ref.make(0);
    const body = {
      model,
      prompt,
      ...params,
      ...(user == null ? {} : { user }),
    } as OpenAI.Images.ImageGenerateParamsNonStreaming;

    const attempt = Effect.tryPromise({
      try: () => client.images.generate(body),
      catch: (error) => classifyApiError(error, model),
    }).pipe(
      Effect.flatMap((result) => {
        const b64 = result.data?.[0]?.b64_json;
        if (b64 == null) {
          return Effect.fail(
            new ProviderError({
              provider: model,
              detail: "No image data returned",
            }),
          );
        }

        const usage =
          result.usage == null
            ? undefined
            : {
                inputTokens: result.usage.input_tokens,
                outputTokens: result.usage.output_tokens,
                totalTokens: result.usage.total_tokens,
              };
        const revisedPrompt = result.data?.[0]?.revised_prompt;
        const costCents =
          usage == null || pricing == null
            ? undefined
            : computeCostCents(usage, pricing);
        const metadata =
          usage == null && revisedPrompt == null
            ? undefined
            : { usage, revisedPrompt, costCents };

        return Effect.succeed({
          buffer: Buffer.from(b64, "base64"),
          metadata,
        });
      }),
    );

    const retryPolicy = Schedule.recurWhile(
      (error: CallError) => error._tag === "RateLimitRetryableError",
    ).pipe(
      Schedule.intersect(Schedule.recurs(MAX_RETRIES - 1)),
      Schedule.addDelayEffect(([error, retries]: [CallError, number]) => {
        if (error._tag !== "RateLimitRetryableError") {
          return Effect.succeed(Duration.zero);
        }

        const hit = retries + 1;
        return Ref.set(rateLimitHitsRef, hit).pipe(
          Effect.zipRight(
            Effect.log(
              `Rate limited - retrying in ${error.delayMs / 1000}s (attempt ${hit}/${MAX_RETRIES})...`,
            ),
          ),
          Effect.as(Duration.millis(error.delayMs)),
        );
      }),
      Schedule.jitteredWith({ min: 1, max: 1.2 }),
    );

    const { buffer, metadata } = yield* Effect.retry(attempt, retryPolicy).pipe(
      Effect.mapError((error) =>
        error._tag === "RateLimitRetryableError"
          ? new RateLimitError({
              provider: model,
              attempts: MAX_RETRIES,
            })
          : error,
      ),
    );
    const rateLimitHits = yield* Ref.get(rateLimitHitsRef);
    const history = [
      ...Array.from({ length: rateLimitHits }, (): HistoryEntry => ({
        provider: providerName,
        status: "rate-limited",
      })),
      { provider: providerName, status: "success" },
    ] satisfies ReadonlyArray<HistoryEntry>;

    return { buffer, history, metadata };
  });
}
