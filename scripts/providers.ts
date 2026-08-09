import OpenAI from "openai";
import {Config, Context, Duration, Effect, Layer, Random, Ref, Schedule} from "effect";
import {DoubleModerationError, ModerationBlockedError, ProviderError, RateLimitExhaustedError} from "./errors.js";

export const MODERATION_FALLBACK    = "xAI";
export const MAX_RETRIES            = 10;
const        RETRY_DELAY_PADDING_MS = 1_000;

export interface ProviderConfig {
    name:     string;
    envKey:   string;
    model:    string;
    baseURL?: string;
    params?:  Record<string, string>;
}

export const PROVIDER_CONFIGS: ProviderConfig[] = [
    {name: "OpenAI", envKey: "OPENAI_API_KEY", model: "gpt-image-2", params: {size: "1024x1024", quality: "low", output_format: "jpeg"}},
    {name: "xAI",    envKey: "XAI_API_KEY",    model: "grok-imagine-image", baseURL: "https://api.x.ai/v1", params: {response_format: "b64_json"}},
];

// ---- HistoryEntry -----------------------------------------------------------

export interface HistoryEntry {
    provider: string;
    status:   "success" | "rate-limited" | "failed";
    message?: string;
}

// ---- ProvidersService -------------------------------------------------------
// Deep interface: callers ask for an image; provider selection, retry, and
// moderation fallback are entirely behind the seam.

export type ProviderFn = (prompt: string) => Effect.Effect<{buffer: Buffer; history: HistoryEntry[]}, ModerationBlockedError | RateLimitExhaustedError | ProviderError>;

export interface ProvidersService {
    generateWithFallback(prompt: string): Effect.Effect<{buffer: Buffer; history: HistoryEntry[]}, DoubleModerationError | ProviderError | RateLimitExhaustedError>;
}

export class ProvidersServiceTag extends Context.Tag("ProvidersService")<ProvidersServiceTag, ProvidersService>() {}

/** Test helper: build a Layer from a pre-constructed provider map (bypasses Config/API key loading). */
export const makeProvidersLayer = (providerMap: Record<string, ProviderFn>): Layer.Layer<ProvidersServiceTag> =>
    Layer.succeed(ProvidersServiceTag, {
        generateWithFallback: (prompt) => generateWithFallback(providerMap, prompt),
    });

export const ProvidersLayer = Layer.effect(ProvidersServiceTag, Effect.gen(function* () {
    if (!PROVIDER_CONFIGS.some(({name}) => name === MODERATION_FALLBACK)) {
        return yield* Effect.die(`MODERATION_FALLBACK "${MODERATION_FALLBACK}" does not match any configured provider`);
    }

    const providerMap = Object.fromEntries(
        yield* Effect.all(PROVIDER_CONFIGS.map(({name, envKey, model, baseURL, params}) =>
            Config.string(envKey).pipe(
                Effect.map((apiKey) => {
                    const client = new OpenAI({apiKey, ...(baseURL != null ? {baseURL} : {})});
                    const fn: ProviderFn = (prompt) => callWithRetry(name, client, model, params ?? {}, prompt);
                    return [name, fn] as const;
                }),
            ),
        )),
    );

    return {
        generateWithFallback: (prompt: string) => generateWithFallback(providerMap, prompt),
    };
}));

// ---- generateWithFallback ---------------------------------------------------

const CANDIDATES = PROVIDER_CONFIGS.map((c) => c.name).filter((n) => n !== MODERATION_FALLBACK);

function generateWithFallback(
    providers: Record<string, ProviderFn>,
    prompt: string,
): Effect.Effect<{buffer: Buffer; history: HistoryEntry[]}, DoubleModerationError | ProviderError | RateLimitExhaustedError> {
    return Effect.gen(function* () {
        const primary = yield* Random.choice(CANDIDATES);
        yield* Effect.log(`Randomly selected ${primary} as primary provider...`);

        return yield* providers[primary](prompt).pipe(
            Effect.catchTag("ModerationBlockedError", (primaryErr) => Effect.gen(function* () {
                yield* Effect.log(`Moderation block on ${primary} - falling back to ${MODERATION_FALLBACK}...`);
                const primaryEntry: HistoryEntry = {provider: primary, status: "failed", message: primaryErr.message};
                return yield* providers[MODERATION_FALLBACK](prompt).pipe(
                    Effect.map(({buffer, history}) => ({buffer, history: [primaryEntry, ...history]})),
                    Effect.catchTag("ModerationBlockedError", () =>
                        Effect.fail(new DoubleModerationError({fallbackProvider: MODERATION_FALLBACK})),
                    ),
                );
            })),
        );
    });
}

// ---- callWithRetry internals ------------------------------------------------

// Internal: a 429 where we successfully parsed the retry delay.
class RateLimitRetryableError {
    readonly _tag = "RateLimitRetryableError";
    constructor(readonly delayMs: number) {}
}

type CallError = ModerationBlockedError | RateLimitRetryableError | ProviderError;

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

function classifyApiError(err: unknown, model: string): CallError {
    const apiErr = err as ApiError;
    if (apiErr?.error?.code === "moderation_blocked") {
        const details = apiErr?.error?.moderation_details;
        const extra = details != null
            ? `\nModeration stage: ${details.moderation_stage}\nCategories: ${(details.categories ?? []).join(", ")}`
            : "";
        return new ModerationBlockedError({provider: model, detail: (apiErr?.message ?? String(err)) + extra});
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
): Effect.Effect<{buffer: Buffer; history: HistoryEntry[]}, ModerationBlockedError | RateLimitExhaustedError | ProviderError> {
    return Effect.gen(function* () {
        const rateLimitHitsRef = yield* Ref.make(0);

        // attempt: pure — no side-effects in the error path
        const attempt = Effect.tryPromise({
            try:   () => client.images.generate({model, prompt, ...params}),
            catch: (err) => classifyApiError(err, model),
        }).pipe(
            Effect.flatMap((result) => {
                const b64 = result.data?.[0]?.b64_json;
                return b64 != null
                    ? Effect.succeed(Buffer.from(b64, "base64"))
                    : Effect.fail(new ProviderError({provider: model, detail: "No image data returned"}));
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

        const buffer = yield* Effect.retry(attempt, retryPolicy).pipe(
            Effect.mapError((e) => e._tag === "RateLimitRetryableError" ? new RateLimitExhaustedError({provider: model, attempts: MAX_RETRIES}) : e),
        );

        const rateLimitHits = yield* Ref.get(rateLimitHitsRef);
        const history: HistoryEntry[] = [
            ...Array.from({length: rateLimitHits}, (): HistoryEntry => ({provider: providerName, status: "rate-limited"})),
            {provider: providerName, status: "success"},
        ];
        return {buffer, history};
    });
}
