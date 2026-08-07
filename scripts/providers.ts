import OpenAI from "openai";
import {Config, Context, Duration, Effect, Layer, Ref, Schedule} from "effect";
import {ModerationBlockedError, ProviderError, RateLimitExhaustedError} from "./errors.js";

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

export type ProviderResult = { buffer: Buffer; rateLimitHits: number };
export type ProviderFn = (prompt: string) => Effect.Effect<ProviderResult, ModerationBlockedError | RateLimitExhaustedError | ProviderError>;

export class ProvidersService extends Context.Tag("ProvidersService")<ProvidersService, Record<string, ProviderFn>>() {}

export const ProvidersLayer = Layer.effect(ProvidersService, Effect.gen(function* () {
    if (!PROVIDER_CONFIGS.some(({name}) => name === MODERATION_FALLBACK)) {
        return yield* Effect.die(`MODERATION_FALLBACK "${MODERATION_FALLBACK}" does not match any configured provider`);
    }

    return Object.fromEntries(
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
}));

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
        return new ModerationBlockedError(model, (apiErr?.message ?? String(err)) + extra);
    }
    if (apiErr?.status === 429) {
        const delayMs = parseRetryDelayMs(apiErr);
        if (delayMs != null) { return new RateLimitRetryableError(delayMs); }
    }
    return new ProviderError(model, apiErr?.message ?? String(err));
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
): Effect.Effect<ProviderResult, ModerationBlockedError | RateLimitExhaustedError | ProviderError> {
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
                    : Effect.fail(new ProviderError(model, "No image data returned"));
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
            Effect.mapError((e) => e._tag === "RateLimitRetryableError" ? new RateLimitExhaustedError(model, MAX_RETRIES) : e),
        );

        return {buffer, rateLimitHits: yield* Ref.get(rateLimitHitsRef)};
    });
}
