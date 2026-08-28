import OpenAI from "openai";
import {Config, Context, Duration, Effect, Layer, Option, Random, Ref, Schedule} from "effect";
import type {ConfigError} from "effect/ConfigError";
import {AllProvidersExhaustedError, ModerationFailedError, ModerationBlockedError, ProviderError, QuotaExhaustedError, RateLimitError} from "./errors.js";

export const MAX_RETRIES            = 10;
const        RETRY_DELAY_PADDING_MS = 1_000;

export interface ModelConfig {
    // The model identifier sent to the API (e.g. "gpt-image-2").
    model:   string;
    // Extra image-generation params for this model (size, quality, etc.).
    // Values may be strings or numbers (e.g. output_compression: 80).
    params?: Record<string, string | number>;
    // Optional display label; defaults to "<provider> (<model>)".
    label?:  string;
}

export interface ProviderConfig {
    // Provider/account name, e.g. "OpenAI". Shared by all of its models.
    name:     string;
    // Env var holding the API key. Unset/blank => the whole provider is disabled.
    envKey:   string;
    // OpenAI-compatible base URL (omit for the default OpenAI endpoint).
    baseURL?: string;
    // One or more models to offer. Each becomes its own selectable candidate.
    models:   ModelConfig[];
}

// A provider is active only when its API key env var is set to a non-empty
// value. To disable one (e.g. temporarily), unset its secret — no code change.

// Primary candidates are chosen at random for normal generation. Every model
// listed under a provider becomes an independent candidate, so adding a model
// here is all it takes to let it be selected.
export const PRIMARY_PROVIDERS: ProviderConfig[] = [
    {
        name:   "OpenAI",
        envKey: "OPENAI_API_KEY",
        models: [
            // moderation:"low" relaxes the content filter so fewer requests are
            // blocked and diverted to the pricey xAI fallback. output_compression
            // shrinks the committed JPEGs (every meme lands in the repo forever).
            {model: "gpt-image-2", params: {size: "1024x1024", quality: "low", output_format: "jpeg", moderation: "low", output_compression: 80}},
        ],
    },
];

// The moderation fallback is used *only* when a primary is blocked by
// moderation. It tends to be more permissive (and more expensive), so it is
// never part of the primary pool. If it lists several models, one is chosen at
// random each time the fallback is invoked.
export const MODERATION_FALLBACK_PROVIDER: ProviderConfig = {
    name:    "xAI",
    envKey:  "XAI_API_KEY",
    baseURL: "https://api.x.ai/v1",
    models: [
        {model: "grok-imagine-image", params: {response_format: "b64_json"}},
    ],
};

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

export type ProviderFn = (prompt: string, user?: string) => Effect.Effect<GenerationResult, ModerationBlockedError | RateLimitError | ProviderError | QuotaExhaustedError>;

export interface ProvidersService {
    generateWithFallback(prompt: string, user?: string): Effect.Effect<GenerationResult, ModerationFailedError | AllProvidersExhaustedError | ProviderError | RateLimitError | QuotaExhaustedError>;
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
        generateWithFallback: (prompt, user) => generateWithFallback(primaries, fallback ?? null, prompt, user),
    });

export const modelLabel = (cfg: ProviderConfig, model: ModelConfig): string =>
    model.label ?? `${cfg.name} (${model.model})`;

/**
 * Build one ProviderFn per model, all sharing a single client. Each candidate
 * is keyed by a unique label so it can be selected, skipped, and reported on
 * independently.
 */
export const makeCandidates = (cfg: ProviderConfig, apiKey: string): ReadonlyArray<readonly [string, ProviderFn]> => {
    const client = new OpenAI({apiKey, ...(cfg.baseURL != null ? {baseURL: cfg.baseURL} : {})});
    return cfg.models.map((m) => {
        const label = modelLabel(cfg, m);
        const fn: ProviderFn = (prompt, user) => callWithRetry(label, client, m.model, m.params ?? {}, prompt, user);
        return [label, fn] as const;
    });
};

/** Load a provider's model candidates iff its API key env var is non-empty. */
const loadProvider = (cfg: ProviderConfig): Effect.Effect<ReadonlyArray<readonly [string, ProviderFn]>, ConfigError> =>
    Effect.gen(function* () {
        const key = yield* Config.option(Config.string(cfg.envKey));
        if (Option.isNone(key) || key.value.trim() === "") { return []; }
        return makeCandidates(cfg, key.value);
    });

export const ProvidersLayer = Layer.effect(ProvidersServiceTag, Effect.gen(function* () {
    const loaded    = yield* Effect.forEach(PRIMARY_PROVIDERS, loadProvider);
    const primaries = Object.fromEntries(loaded.flat());

    if (Object.keys(primaries).length === 0) {
        return yield* Effect.die("No image provider configured: set at least one primary provider API key.");
    }

    // The moderation fallback may offer several models; pick one at random per call.
    const fallbackCandidates = (yield* loadProvider(MODERATION_FALLBACK_PROVIDER)).map(([, fn]) => fn);
    const fallback: ProviderFn | null = fallbackCandidates.length === 0
        ? null
        : (prompt, user) => Random.choice(fallbackCandidates).pipe(Effect.orDie, Effect.flatMap((fn) => fn(prompt, user)));

    return {
        generateWithFallback: (prompt: string, user?: string) => generateWithFallback(primaries, fallback, prompt, user),
    };
}));

// ---- generateWithFallback ---------------------------------------------------

type GenerateError = ModerationFailedError | AllProvidersExhaustedError | ProviderError | RateLimitError | QuotaExhaustedError;

function generateWithFallback(
    primaries: Record<string, ProviderFn>,
    fallback: ProviderFn | null,
    prompt: string,
    user?: string,
): Effect.Effect<GenerationResult, GenerateError> {
    // Object.keys is non-empty for the real layer (guarded above) and for every
    // test; an empty map is a programmer error, surfaced as a defect below.
    return tryPrimaries(primaries, Object.keys(primaries), [], fallback, prompt, user);
}

/**
 * Try primary providers one at a time in random order. A provider that is out
 * of credits/quota is skipped and the next one is tried; a moderation block
 * diverts to the dedicated fallback provider. Other errors propagate, but every
 * terminal failure carries the full attempt history so it can be reported.
 */
function tryPrimaries(
    primaries: Record<string, ProviderFn>,
    remaining: string[],
    skipped: HistoryEntry[],
    fallback: ProviderFn | null,
    prompt: string,
    user?: string,
): Effect.Effect<GenerationResult, GenerateError> {
    return Effect.gen(function* () {
        if (remaining.length === 0) {
            return yield* Effect.fail(new AllProvidersExhaustedError({providers: skipped.map((e) => e.provider), history: skipped}));
        }

        const primary = yield* Random.choice(remaining).pipe(Effect.orDie);
        const rest    = remaining.filter((name) => name !== primary);
        yield* Effect.log(`Selected ${primary} as primary provider...`);

        return yield* primaries[primary](prompt, user).pipe(
            Effect.map((result) => ({...result, history: [...skipped, ...result.history]})),
            Effect.catchTag("QuotaExhaustedError", (err) => Effect.gen(function* () {
                yield* Effect.logWarning(`${primary} is out of credits/quota - skipping. ${err.detail}`);
                const entry: HistoryEntry = {provider: primary, status: "failed", message: err.message};
                return yield* tryPrimaries(primaries, rest, [...skipped, entry], fallback, prompt, user);
            })),
            Effect.catchTag("ModerationBlockedError", (err) =>
                runModerationFallback(primary, err, skipped, fallback, prompt, user)),
            // RateLimitError / ProviderError are terminal: attach the accumulated
            // history (including this primary's failure) so the notifier can report it.
            Effect.catchTags({
                RateLimitError: (err) => Effect.fail(err.history != null ? err : new RateLimitError({
                    provider: err.provider, attempts: err.attempts,
                    history: [...skipped, {provider: primary, status: "failed", message: err.message}],
                })),
                ProviderError: (err) => Effect.fail(err.history != null ? err : new ProviderError({
                    provider: err.provider, detail: err.detail,
                    history: [...skipped, {provider: primary, status: "failed", message: err.message}],
                })),
            }),
        );
    });
}

function runModerationFallback(
    primary: string,
    primaryErr: ModerationBlockedError,
    skipped: HistoryEntry[],
    fallback: ProviderFn | null,
    prompt: string,
    user?: string,
): Effect.Effect<GenerationResult, GenerateError> {
    return Effect.gen(function* () {
        const primaryEntry: HistoryEntry = {provider: primary, status: "failed", message: primaryErr.message};
        const priorHistory = [...skipped, primaryEntry];

        if (fallback == null) {
            yield* Effect.log(`Moderation block on ${primary} - no fallback provider available.`);
            return yield* Effect.fail(new ModerationFailedError({fallbackProvider: null, history: priorHistory}));
        }

        yield* Effect.log(`Moderation block on ${primary} - falling back to ${MODERATION_FALLBACK_PROVIDER.name}...`);

        return yield* fallback(prompt, user).pipe(
            Effect.map((result) => ({...result, history: [...priorHistory, ...result.history]})),
            Effect.catchTag("ModerationBlockedError", (fallbackErr) =>
                Effect.fail(new ModerationFailedError({
                    fallbackProvider: MODERATION_FALLBACK_PROVIDER.name,
                    history: [...priorHistory, {provider: fallbackErr.provider, status: "failed", message: fallbackErr.message}],
                }))),
            // The fallback ran out of credits (or otherwise failed): keep the
            // primary's moderation attempt in the reported history.
            Effect.catchTags({
                QuotaExhaustedError: (err) => Effect.fail(new QuotaExhaustedError({
                    provider: err.provider, detail: err.detail,
                    history: [...priorHistory, {provider: err.provider, status: "failed", message: err.message}],
                })),
                RateLimitError: (err) => Effect.fail(new RateLimitError({
                    provider: err.provider, attempts: err.attempts,
                    history: [...priorHistory, {provider: err.provider, status: "failed", message: err.message}],
                })),
                ProviderError: (err) => Effect.fail(new ProviderError({
                    provider: err.provider, detail: err.detail,
                    history: [...priorHistory, {provider: err.provider, status: "failed", message: err.message}],
                })),
            }),
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
    params: Record<string, string | number>,
    prompt: string,
    user?: string,
): Effect.Effect<GenerationResult, ModerationBlockedError | RateLimitError | ProviderError | QuotaExhaustedError> {
    return Effect.gen(function* () {
        const rateLimitHitsRef = yield* Ref.make(0);

        // `user` is a stable, opaque end-user id (the Slack sender) forwarded to
        // OpenAI for abuse monitoring; omitted when not provided.
        const body = {
            model,
            prompt,
            ...params,
            ...(user != null ? {user} : {}),
        } as OpenAI.Images.ImageGenerateParamsNonStreaming;

        // attempt: pure — no side-effects in the error path
        const attempt = Effect.tryPromise({
            try:   () => client.images.generate(body),
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
