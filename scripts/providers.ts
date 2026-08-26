import OpenAI from "openai";
import {Config, Context, Duration, Effect, Layer, Option, Random, Ref, Schedule} from "effect";
import type {ConfigError} from "effect/ConfigError";
import {AllProvidersExhaustedError, ModerationFailedError, ModerationBlockedError, ProviderError, QuotaExhaustedError, RateLimitError} from "./errors.js";

export const MAX_RETRIES            = 10;
const        RETRY_DELAY_PADDING_MS = 1_000;

export interface ProviderConfig {
    name:     string;
    envKey:   string;
    model:    string;
    baseURL?: string;
    params?:  Record<string, string>;
}

// A provider is active only when its API key env var is set to a non-empty
// value. To disable one (e.g. temporarily), unset its secret — no code change.

// Primary providers are chosen at random for normal generation.
export const PRIMARY_PROVIDERS: ProviderConfig[] = [
    {name: "OpenAI", envKey: "OPENAI_API_KEY", model: "gpt-image-2", params: {size: "1024x1024", quality: "low", output_format: "jpeg"}},
];

// The moderation fallback is used *only* when a primary is blocked by
// moderation. It tends to be more permissive (and more expensive), so it is
// never part of the primary pool.
export const MODERATION_FALLBACK_PROVIDER: ProviderConfig =
    {name: "xAI", envKey: "XAI_API_KEY", model: "grok-imagine-image", baseURL: "https://api.x.ai/v1", params: {response_format: "b64_json"}};

// ---- HistoryEntry -----------------------------------------------------------

export interface HistoryEntry {
    provider: string;
    status:   "success" | "rate-limited" | "failed";
    message?: string;
}

export interface UsageEntry {
    inputTokens:  number;
    outputTokens: number;
    totalTokens:  number;
}

export interface GenerationMetadata {
    revisedPrompt?: string;
    usage?:         UsageEntry;
}

export interface GenerationResult {
    buffer:   Buffer;
    history:  HistoryEntry[];
    metadata?: GenerationMetadata;
}

// ---- ProvidersService -------------------------------------------------------
// Deep interface: callers ask for an image; provider selection, retry, and
// moderation fallback are entirely behind the seam.

export type ProviderFn = (prompt: string) => Effect.Effect<GenerationResult, ModerationBlockedError | RateLimitError | ProviderError | QuotaExhaustedError>;

export interface ProvidersService {
    generateWithFallback(prompt: string): Effect.Effect<GenerationResult, ModerationFailedError | AllProvidersExhaustedError | ProviderError | RateLimitError | QuotaExhaustedError>;
}

export class ProvidersServiceTag extends Context.Tag("ProvidersService")<ProvidersServiceTag, ProvidersService>() {}

/**
 * Test helper: build a Layer from pre-constructed providers (bypasses
 * Config/API key loading). `fallback` is the moderation-fallback provider;
 * omit it to model a deployment where no fallback is configured.
 */
export const makeProvidersLayer = (
    primaries: Record<string, ProviderFn>,
    fallback?: ProviderFn,
): Layer.Layer<ProvidersServiceTag> =>
    Layer.succeed(ProvidersServiceTag, {
        generateWithFallback: (prompt) => generateWithFallback(primaries, fallback ?? null, prompt),
    });

const makeProviderFn = (cfg: ProviderConfig, apiKey: string): ProviderFn => {
    const client = new OpenAI({apiKey, ...(cfg.baseURL != null ? {baseURL: cfg.baseURL} : {})});
    return (prompt) => callWithRetry(cfg.name, client, cfg.model, cfg.params ?? {}, prompt);
};

/** Load a provider iff its API key env var is set to a non-empty value. */
const loadProvider = (cfg: ProviderConfig): Effect.Effect<Option.Option<readonly [string, ProviderFn]>, ConfigError> =>
    Effect.gen(function* () {
        const key = yield* Config.option(Config.string(cfg.envKey));
        if (Option.isNone(key) || key.value.trim() === "") { return Option.none(); }
        return Option.some([cfg.name, makeProviderFn(cfg, key.value)] as const);
    });

export const ProvidersLayer = Layer.effect(ProvidersServiceTag, Effect.gen(function* () {
    const loaded    = yield* Effect.forEach(PRIMARY_PROVIDERS, loadProvider);
    const primaries = Object.fromEntries(loaded.filter(Option.isSome).map((entry) => entry.value));

    if (Object.keys(primaries).length === 0) {
        return yield* Effect.die("No image provider configured: set at least one primary provider API key.");
    }

    const fallback = Option.getOrNull(
        (yield* loadProvider(MODERATION_FALLBACK_PROVIDER)).pipe(Option.map(([, fn]) => fn)),
    );

    return {
        generateWithFallback: (prompt: string) => generateWithFallback(primaries, fallback, prompt),
    };
}));

// ---- generateWithFallback ---------------------------------------------------

type GenerateError = ModerationFailedError | AllProvidersExhaustedError | ProviderError | RateLimitError | QuotaExhaustedError;

function generateWithFallback(
    primaries: Record<string, ProviderFn>,
    fallback: ProviderFn | null,
    prompt: string,
): Effect.Effect<GenerationResult, GenerateError> {
    // Object.keys is non-empty for the real layer (guarded above) and for every
    // test; an empty map is a programmer error, surfaced as a defect below.
    return tryPrimaries(primaries, Object.keys(primaries), [], fallback, prompt);
}

/**
 * Try primary providers one at a time in random order. A provider that is out
 * of credits/quota is skipped and the next one is tried; a moderation block
 * diverts to the dedicated fallback provider. Other errors propagate.
 */
function tryPrimaries(
    primaries: Record<string, ProviderFn>,
    remaining: string[],
    skipped: HistoryEntry[],
    fallback: ProviderFn | null,
    prompt: string,
): Effect.Effect<GenerationResult, GenerateError> {
    return Effect.gen(function* () {
        if (remaining.length === 0) {
            return yield* Effect.fail(new AllProvidersExhaustedError({providers: skipped.map((e) => e.provider)}));
        }

        const primary = yield* Random.choice(remaining).pipe(Effect.orDie);
        const rest    = remaining.filter((name) => name !== primary);
        yield* Effect.log(`Selected ${primary} as primary provider...`);

        return yield* primaries[primary](prompt).pipe(
            Effect.map((result) => ({...result, history: [...skipped, ...result.history]})),
            Effect.catchTag("QuotaExhaustedError", (err) => Effect.gen(function* () {
                yield* Effect.logWarning(`${primary} is out of credits/quota - skipping. ${err.detail}`);
                const entry: HistoryEntry = {provider: primary, status: "failed", message: err.message};
                return yield* tryPrimaries(primaries, rest, [...skipped, entry], fallback, prompt);
            })),
            Effect.catchTag("ModerationBlockedError", (err) =>
                runModerationFallback(primary, err, skipped, fallback, prompt)),
        );
    });
}

function runModerationFallback(
    primary: string,
    primaryErr: ModerationBlockedError,
    skipped: HistoryEntry[],
    fallback: ProviderFn | null,
    prompt: string,
): Effect.Effect<GenerationResult, GenerateError> {
    return Effect.gen(function* () {
        if (fallback == null) {
            yield* Effect.log(`Moderation block on ${primary} - no fallback provider available.`);
            return yield* Effect.fail(new ModerationFailedError({fallbackProvider: null}));
        }

        yield* Effect.log(`Moderation block on ${primary} - falling back to ${MODERATION_FALLBACK_PROVIDER.name}...`);
        const primaryEntry: HistoryEntry = {provider: primary, status: "failed", message: primaryErr.message};

        return yield* fallback(prompt).pipe(
            Effect.map((result) => ({...result, history: [...skipped, primaryEntry, ...result.history]})),
            Effect.catchTag("ModerationBlockedError", () =>
                Effect.fail(new ModerationFailedError({fallbackProvider: MODERATION_FALLBACK_PROVIDER.name}))),
        );
    });
}

// ---- callWithRetry internals ------------------------------------------------

// Internal: a 429 where we successfully parsed the retry delay.
class RateLimitRetryableError {
    readonly _tag = "RateLimitRetryableError";
    constructor(readonly delayMs: number) {}
}

type CallError = ModerationBlockedError | RateLimitRetryableError | ProviderError | QuotaExhaustedError;

// OpenAI error shape for catch-clause narrowing
interface ApiError {
    status?: number;
    message?: string;
    headers?: Record<string, string>;
    error?: {
        code?: string;
        moderation_details?: { moderation_stage: string; categories?: string[] };
    };
}

// A provider is "out of tokens" when its account has no credits or has hit a
// spending/quota limit. These never resolve by retrying, so we skip the
// provider entirely. Covers OpenAI (429 insufficient_quota / 403 billing
// hard limit) and xAI (403 with a credits/spending-limit message).
function isQuotaExhausted(err: ApiError): boolean {
    const code = err?.error?.code;
    if (code === "insufficient_quota" || code === "billing_hard_limit_reached") { return true; }
    if (err?.status === 403 && /credit|spending limit|quota|billing/i.test(err?.message ?? "")) { return true; }
    return false;
}

function classifyApiError(err: unknown, model: string): CallError {
    const apiErr = err as ApiError;
    if (apiErr?.error?.code === "moderation_blocked") {
        const details = apiErr?.error?.moderation_details;
        const extra = details != null
            ? `\nModeration stage: ${details.moderation_stage}\nCategories: ${(details.categories ?? []).join(", ")}`
            : "";
        return new ModerationBlockedError({provider: model, detail: (apiErr?.message ?? String(err)) + extra});
    }
    if (isQuotaExhausted(apiErr)) {
        return new QuotaExhaustedError({provider: model, detail: apiErr?.message ?? String(err)});
    }
    if (apiErr?.status === 429) {
        const delayMs = parseRetryDelayMs(apiErr);
        if (delayMs != null) { return new RateLimitRetryableError(delayMs); }
    }
    return new ProviderError({provider: model, detail: apiErr?.message ?? String(err)});
}

function parseRetryDelayMs(err: ApiError): number | null {
    const fromHeader = parseInt(err?.headers?.["retry-after"] ?? "", 10);
    if (!isNaN(fromHeader)) { return fromHeader * 1000 + RETRY_DELAY_PADDING_MS; }
    const match = (err?.message ?? "").match(/try again in (\d+(?:\.\d+)?)s/i);
    return match != null ? parseFloat(match[1]) * 1000 + RETRY_DELAY_PADDING_MS : null;
}

export function callWithRetry(
    providerName: string,
    client: OpenAI,
    model: string,
    params: Record<string, string>,
    prompt: string,
): Effect.Effect<GenerationResult, ModerationBlockedError | RateLimitError | ProviderError | QuotaExhaustedError> {
    return Effect.gen(function* () {
        const rateLimitHitsRef = yield* Ref.make(0);

        // attempt: pure — no side-effects in the error path
        const attempt = Effect.tryPromise({
            try:   () => client.images.generate({model, prompt, ...params}),
            catch: (err) => classifyApiError(err, model),
        }).pipe(
            Effect.flatMap((result) => {
                const b64 = result.data?.[0]?.b64_json;
                if (b64 == null) {
                    return Effect.fail(new ProviderError({provider: model, detail: "No image data returned"}));
                }
                const usage = result.usage != null
                    ? {
                        inputTokens:  result.usage.input_tokens,
                        outputTokens: result.usage.output_tokens,
                        totalTokens:  result.usage.total_tokens,
                    }
                    : undefined;
                const revisedPrompt = result.data?.[0]?.revised_prompt;
                const metadata = usage != null || revisedPrompt != null
                    ? {usage, revisedPrompt}
                    : undefined;
                return Effect.succeed({buffer: Buffer.from(b64, "base64"), metadata});
            }),
        );

        // Schedule owns all timing and logging.
        // intersect output is [CallError, number]; `n` is the 0-indexed retry count from recurs.
        // Schedule.jittered adds ±20% randomisation so concurrent rate-limited jobs don't retry in lockstep.
        const retryPolicy = Schedule.recurWhile((e: CallError) => e._tag === "RateLimitRetryableError").pipe(
            Schedule.intersect(Schedule.recurs(MAX_RETRIES - 1)),
            Schedule.addDelayEffect(([e, n]: [CallError, number]) => {
                if (e._tag !== "RateLimitRetryableError") { return Effect.succeed(Duration.zero); }
                const hit = n + 1;
                return Ref.set(rateLimitHitsRef, hit).pipe(
                    Effect.zipRight(Effect.log(`Rate limited - retrying in ${e.delayMs / 1000}s (attempt ${hit}/${MAX_RETRIES})...`)),
                    Effect.as(Duration.millis(e.delayMs)),
                );
            }),
            Schedule.jittered,
        );

        const {buffer, metadata} = yield* Effect.retry(attempt, retryPolicy).pipe(
            Effect.mapError((e) => e._tag === "RateLimitRetryableError" ? new RateLimitError({provider: model, attempts: MAX_RETRIES}) : e),
        );

        const rateLimitHits = yield* Ref.get(rateLimitHitsRef);
        const history: HistoryEntry[] = [
            ...Array.from({length: rateLimitHits}, (): HistoryEntry => ({provider: providerName, status: "rate-limited"})),
            {provider: providerName, status: "success"},
        ];
        return {buffer, history, metadata};
    });
}
