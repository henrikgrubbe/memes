import OpenAI from "openai";
import {
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Random,
  Ref,
  Schedule,
} from "effect";
import type { ConfigError } from "effect/ConfigError";
import {
  AllProvidersExhaustedError,
  ModerationBlockedError,
  ModerationFailedError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "./errors.js";
import type { HistoryEntry } from "./history.js";

export const MAX_RETRIES = 10;
const RETRY_DELAY_PADDING_MS = 1_000;

export interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

export interface ModelConfig {
  readonly model: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly pricing?: ModelPricing;
  readonly label?: string;
}

export interface ProviderConfig {
  readonly name: string;
  readonly envKey: string;
  readonly baseURL?: string;
  readonly models: ReadonlyArray<ModelConfig>;
}

// A provider is active only when its API key env var is set to a non-empty
// value. To disable one (e.g. temporarily), unset its secret - no code change.

// Primary candidates are chosen at random for normal generation. Every model
// listed under a provider becomes an independent candidate, so adding a model
// here is all it takes to let it be selected.
export const PRIMARY_PROVIDERS: ProviderConfig[] = [
  {
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    models: [
      // moderation:"low" relaxes the content filter so fewer requests are
      // blocked and diverted to the pricey xAI fallback. output_compression
      // shrinks the committed JPEGs (every meme lands in the repo forever).
      {
        model: "gpt-image-2",
        params: {
          size: "1024x1024",
          quality: "low",
          output_format: "jpeg",
          moderation: "low",
          output_compression: 80,
        },
        pricing: { inputPerMillion: 5, outputPerMillion: 30 },
      },
    ],
  },
];

// The moderation fallback is used *only* when a primary is blocked by
// moderation. It tends to be more permissive (and more expensive), so it is
// never part of the primary pool. If it lists several models, one is chosen at
// random each time the fallback is invoked.
export const MODERATION_FALLBACK_PROVIDER: ProviderConfig = {
  name: "xAI",
  envKey: "XAI_API_KEY",
  baseURL: "https://api.x.ai/v1",
  models: [
    { model: "grok-imagine-image", params: { response_format: "b64_json" } },
  ],
};

export interface UsageEntry {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface GenerationMetadata {
  readonly revisedPrompt?: string;
  readonly usage?: UsageEntry;
  readonly costCents?: number;
}

/** Estimated cost in cents for a generation, from its token usage and pricing. */
export function computeCostCents(
  usage: UsageEntry,
  pricing: ModelPricing,
): number {
  return (
    ((usage.inputTokens * pricing.inputPerMillion +
      usage.outputTokens * pricing.outputPerMillion) /
      1_000_000) *
    100
  );
}

export interface GenerationResult {
  readonly buffer: Buffer;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly metadata?: GenerationMetadata;
}

// ---- ProvidersService -------------------------------------------------------
// Deep interface: callers ask for an image; provider selection, retry, and
// moderation fallback are entirely behind the seam.

export type ProviderFn = (
  prompt: string,
  user?: string,
) => Effect.Effect<
  GenerationResult,
  ModerationBlockedError | RateLimitError | ProviderError | QuotaExhaustedError
>;

export interface ProvidersService {
  readonly generateWithFallback: (
    prompt: string,
    user?: string,
  ) => Effect.Effect<
    GenerationResult,
    | ModerationFailedError
    | AllProvidersExhaustedError
    | ProviderError
    | RateLimitError
    | QuotaExhaustedError
  >;
}

export class ProvidersServiceTag extends Context.Tag("ProvidersService")<
  ProvidersServiceTag,
  ProvidersService
>() {}

/**
 * Test helper: build a Layer from pre-constructed providers (bypasses
 * Config/API key loading). `fallback` is the moderation-fallback provider;
 * omit it to model a deployment where no fallback is configured.
 */
export const makeProvidersLayer = (
  primaries: Readonly<Record<string, ProviderFn>>,
  fallback?: ProviderFn,
): Layer.Layer<ProvidersServiceTag> =>
  Layer.succeed(ProvidersServiceTag, {
    generateWithFallback: (prompt, user) =>
      generateWithFallback(primaries, fallback ?? null, prompt, user),
  });

export const modelLabel = (cfg: ProviderConfig, model: ModelConfig): string =>
  model.label ?? `${cfg.name} (${model.model})`;

/**
 * Build one ProviderFn per model, all sharing a single client. Each candidate
 * is keyed by a unique label so it can be selected, skipped, and reported on
 * independently.
 */
export const makeCandidates = (
  cfg: ProviderConfig,
  apiKey: string,
): ReadonlyArray<readonly [string, ProviderFn]> => {
  const client = new OpenAI({
    apiKey,
    ...(cfg.baseURL == null ? {} : { baseURL: cfg.baseURL }),
  });

  return cfg.models.map((model) => {
    const label = modelLabel(cfg, model);
    const fn: ProviderFn = (prompt, user) =>
      callWithRetry(
        label,
        client,
        model.model,
        model.params ?? {},
        prompt,
        user,
        model.pricing,
      );

    return [label, fn] as const;
  });
};

/** Load a provider's model candidates iff its API key env var is non-empty. */
const loadProvider = (
  cfg: ProviderConfig,
): Effect.Effect<ReadonlyArray<readonly [string, ProviderFn]>, ConfigError> =>
  Config.option(Config.string(cfg.envKey)).pipe(
    Effect.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value.trim() === "" ? [] : makeCandidates(cfg, value),
      }),
    ),
  );

export const ProvidersLayer = Layer.effect(
  ProvidersServiceTag,
  Effect.gen(function* () {
    const loaded = yield* Effect.forEach(PRIMARY_PROVIDERS, loadProvider);
    const primaries = Object.fromEntries(loaded.flat());

    if (Object.keys(primaries).length === 0) {
      return yield* Effect.die(
        "No image provider configured: set at least one primary provider API key.",
      );
    }

    const fallbackCandidates = (yield* loadProvider(
      MODERATION_FALLBACK_PROVIDER,
    )).map(([, candidate]) => candidate);
    const fallback: ProviderFn | null =
      fallbackCandidates.length === 0
        ? null
        : (prompt, user) =>
            Random.choice(fallbackCandidates).pipe(
              Effect.orDie,
              Effect.flatMap((candidate) => candidate(prompt, user)),
            );

    return {
      generateWithFallback: (prompt, user) =>
        generateWithFallback(primaries, fallback, prompt, user),
    };
  }),
);

// ---- generateWithFallback ---------------------------------------------------

type ProviderPool = Readonly<Record<string, ProviderFn>>;
type GenerateError =
  | ModerationFailedError
  | AllProvidersExhaustedError
  | ProviderError
  | RateLimitError
  | QuotaExhaustedError;
type AttemptError =
  | ModerationBlockedError
  | ProviderError
  | RateLimitError
  | QuotaExhaustedError;
type HistoryError = Exclude<AttemptError, ModerationBlockedError>;

const failedAttempt = (provider: string, message: string): HistoryEntry => ({
  provider,
  status: "failed",
  message,
});

function reconstructWithHistory(
  error: HistoryError,
  history: ReadonlyArray<HistoryEntry>,
): HistoryError {
  switch (error._tag) {
    case "ProviderError":
      return new ProviderError({ ...error, history });
    case "RateLimitError":
      return new RateLimitError({ ...error, history });
    case "QuotaExhaustedError":
      return new QuotaExhaustedError({ ...error, history });
  }
}

function withAttemptHistory<A>(
  effect: Effect.Effect<A, AttemptError>,
  prior: ReadonlyArray<HistoryEntry>,
  provider: string,
): Effect.Effect<A, AttemptError> {
  return effect.pipe(
    Effect.mapError((error) => {
      if (error._tag === "ModerationBlockedError") {
        return error;
      }

      const attempt = failedAttempt(provider, error.message);
      const history = [...prior, attempt, ...(error.history ?? [])];
      return reconstructWithHistory(error, history);
    }),
  );
}

function generateWithFallback(
  primaries: ProviderPool,
  fallback: ProviderFn | null,
  prompt: string,
  user?: string,
): Effect.Effect<GenerationResult, GenerateError> {
  return tryPrimaries(
    primaries,
    Object.keys(primaries),
    [],
    fallback,
    prompt,
    user,
  );
}

function tryPrimaries(
  primaries: ProviderPool,
  remaining: ReadonlyArray<string>,
  skipped: ReadonlyArray<HistoryEntry>,
  fallback: ProviderFn | null,
  prompt: string,
  user?: string,
): Effect.Effect<GenerationResult, GenerateError> {
  return Effect.gen(function* () {
    if (remaining.length === 0) {
      return yield* new AllProvidersExhaustedError({
        providers: skipped.map(({ provider }) => provider),
        history: skipped,
      });
    }

    const primary = yield* Random.choice(remaining).pipe(Effect.orDie);
    const rest = remaining.filter((name) => name !== primary);
    yield* Effect.log(`Selected ${primary} as primary provider...`);

    const attempt = withAttemptHistory(
      primaries[primary](prompt, user),
      skipped,
      primary,
    );

    return yield* attempt.pipe(
      Effect.map((result) => ({
        ...result,
        history: [...skipped, ...result.history],
      })),
      Effect.catchTags({
        QuotaExhaustedError: (error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              `${primary} is out of credits/quota - skipping. ${error.detail}`,
            );
            return yield* tryPrimaries(
              primaries,
              rest,
              error.history ?? skipped,
              fallback,
              prompt,
              user,
            );
          }),
        ModerationBlockedError: (error) =>
          runModerationFallback(
            primary,
            error,
            skipped,
            fallback,
            prompt,
            user,
          ),
      }),
    );
  });
}

function runModerationFallback(
  primary: string,
  primaryErr: ModerationBlockedError,
  skipped: ReadonlyArray<HistoryEntry>,
  fallback: ProviderFn | null,
  prompt: string,
  user?: string,
): Effect.Effect<GenerationResult, GenerateError> {
  return Effect.gen(function* () {
    const primaryEntry = failedAttempt(primary, primaryErr.message);
    const priorHistory = [...skipped, primaryEntry];
    const moderationFailure = (
      fallbackProvider: string | null,
      fallbackDetail?: string,
      fallbackEntry?: HistoryEntry,
    ) =>
      new ModerationFailedError({
        provider: primaryErr.provider,
        detail: primaryErr.detail,
        fallbackProvider,
        fallbackDetail,
        history:
          fallbackEntry == null
            ? priorHistory
            : [...priorHistory, fallbackEntry],
      });

    if (fallback == null) {
      yield* Effect.log(
        `Moderation block on ${primary} - no fallback provider available.`,
      );
      return yield* moderationFailure(null);
    }

    yield* Effect.log(
      `Moderation block on ${primary} - falling back to ${MODERATION_FALLBACK_PROVIDER.name}...`,
    );

    return yield* fallback(prompt, user).pipe(
      Effect.map((result) => ({
        ...result,
        history: [...priorHistory, ...result.history],
      })),
      Effect.catchTag("ModerationBlockedError", (error) =>
        Effect.fail(
          moderationFailure(
            error.provider,
            "also blocked by moderation",
            failedAttempt(error.provider, error.message),
          ),
        ),
      ),
      Effect.catchTags({
        QuotaExhaustedError: (error) =>
          Effect.fail(
            moderationFailure(
              error.provider,
              "out of credits/quota",
              failedAttempt(error.provider, error.message),
            ),
          ),
        RateLimitError: (error) =>
          Effect.fail(
            moderationFailure(
              error.provider,
              "rate-limit retries exhausted",
              failedAttempt(error.provider, error.message),
            ),
          ),
        ProviderError: (error) =>
          Effect.fail(
            moderationFailure(
              error.provider,
              error.detail,
              failedAttempt(error.provider, error.message),
            ),
          ),
      }),
    );
  });
}

// ---- callWithRetry internals ------------------------------------------------

// Internal: a 429 where we successfully parsed the retry delay.
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
  readonly headers?: Readonly<Record<string, string>>;
  readonly error?: {
    readonly code?: string;
    readonly moderation_details?: {
      readonly moderation_stage: string;
      readonly categories?: ReadonlyArray<string>;
    };
  };
}

function isQuotaExhausted(err: ApiError | null | undefined): boolean {
  const code = err?.error?.code;
  return (
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    (err?.status === 403 &&
      /credit|spending limit|quota|billing/i.test(err?.message ?? ""))
  );
}

function classifyApiError(err: unknown, model: string): CallError {
  const apiErr = err as ApiError | null | undefined;
  if (apiErr?.error?.code === "moderation_blocked") {
    const details = apiErr?.error?.moderation_details;
    const extra =
      details != null
        ? `\nModeration stage: ${details.moderation_stage}\nCategories: ${(details.categories ?? []).join(", ")}`
        : "";
    return new ModerationBlockedError({
      provider: model,
      detail: (apiErr.message ?? String(err)) + extra,
    });
  }
  if (isQuotaExhausted(apiErr)) {
    return new QuotaExhaustedError({
      provider: model,
      detail: apiErr?.message ?? String(err),
    });
  }
  if (apiErr?.status === 429) {
    const delayMs = parseRetryDelayMs(apiErr);
    if (delayMs != null) {
      return new RateLimitRetryableError(delayMs);
    }
  }
  return new ProviderError({
    provider: model,
    detail: apiErr?.message ?? String(err),
  });
}

function parseRetryDelayMs(err: ApiError): number | null {
  const fromHeader = parseInt(err.headers?.["retry-after"] ?? "", 10);
  if (!isNaN(fromHeader)) {
    return fromHeader * 1000 + RETRY_DELAY_PADDING_MS;
  }

  const match = (err.message ?? "").match(/try again in (\d+(?:\.\d+)?)s/i);
  return match == null
    ? null
    : parseFloat(match[1]) * 1000 + RETRY_DELAY_PADDING_MS;
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
      ...(user != null ? { user } : {}),
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
          result.usage != null
            ? {
                inputTokens: result.usage.input_tokens,
                outputTokens: result.usage.output_tokens,
                totalTokens: result.usage.total_tokens,
              }
            : undefined;
        const revisedPrompt = result.data?.[0]?.revised_prompt;
        const costCents =
          usage != null && pricing != null
            ? computeCostCents(usage, pricing)
            : undefined;
        const metadata =
          usage != null || revisedPrompt != null
            ? { usage, revisedPrompt, costCents }
            : undefined;

        return Effect.succeed({ buffer: Buffer.from(b64, "base64"), metadata });
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
      Schedule.jittered,
    );

    const { buffer, metadata } = yield* Effect.retry(attempt, retryPolicy).pipe(
      Effect.mapError((error) =>
        error._tag === "RateLimitRetryableError"
          ? new RateLimitError({ provider: model, attempts: MAX_RETRIES })
          : error,
      ),
    );

    const rateLimitHits = yield* Ref.get(rateLimitHitsRef);
    const history = [
      ...Array.from(
        { length: rateLimitHits },
        (): HistoryEntry => ({
          provider: providerName,
          status: "rate-limited",
        }),
      ),
      { provider: providerName, status: "success" },
    ] satisfies ReadonlyArray<HistoryEntry>;

    return { buffer, history, metadata };
  });
}
