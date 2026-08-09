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

export type ProviderFn = (prompt: string) => Effect.Effect<{buffer: Buffer; rateLimitHits: number}, ModerationBlockedError | RateLimitExhaustedError | ProviderError>;

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
                    const fn: ProviderFn = (prompt) => callWithRetry(client, model, params ?? {}, prompt);
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
            Effect.map(({buffer, rateLimitHits}) => ({
                buffer,
                history: [
                    ...Array.from({length: rateLimitHits}, (): HistoryEntry => ({provider: primary, status: "rate-limited"})),
                    {provider: primary, status: "success" as const},
                ],
            })),
            Effect.catchTag("ModerationBlockedError", (primaryErr) => Effect.gen(function* () {
                yield* Effect.log(`Moderation block on ${primary} - falling back to ${MODERATION_FALLBACK}...`);
                const primaryEntry: HistoryEntry = {provider: primary, status: "failed", message: primaryErr.message};
                return yield* providers[MODERATION_FALLBACK](prompt).pipe(
                    Effect.map(({buffer, rateLimitHits}) => ({
                        buffer,
                        history: [
                            primaryEntry,
                            ...Array.from({length: rateLimitHits}, (): HistoryEntry => ({provider: MODERATION_FALLBACK, status: "rate-limited"})),
                            {provider: MODERATION_FALLBACK, status: "success" as const},
                        ],
                    })),
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
    client: OpenAI,
    model: string,
    params: Record<string, string>,
    prompt: string,
): Effect.Effect<{buffer: Buffer; rateLimitHits: number}, ModerationBlockedError | RateLimitExhaustedError | ProviderError> {
    return Effect.gen(function* () {
        const rateLimitHitsRef = yield* Ref.make(0);

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
            Effect.tapError((e) => {
                if (e._tag !== "RateLimitRetryableError") { return Effect.void; }
                return Effect.gen(function* () {
                    const hits = yield* Ref.updateAndGet(rateLimitHitsRef, (n) => n + 1);
                    yield* Effect.log(`Rate limited - retrying in ${e.delayMs / 1000}s (attempt ${hits}/${MAX_RETRIES})...`);
                    yield* Effect.sleep(Duration.millis(e.delayMs));
                });
            }),
        );

        const retryPolicy = Schedule.recurWhile((e: CallError) => e._tag === "RateLimitRetryableError").pipe(
            Schedule.intersect(Schedule.recurs(MAX_RETRIES - 1)),
        );

        const buffer = yield* Effect.retry(attempt, retryPolicy).pipe(
            Effect.mapError((e) => e._tag === "RateLimitRetryableError" ? new RateLimitExhaustedError({provider: model, attempts: MAX_RETRIES}) : e),
        );

        return {buffer, rateLimitHits: yield* Ref.get(rateLimitHitsRef)};
    });
}
