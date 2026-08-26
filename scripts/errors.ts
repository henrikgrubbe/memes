/**
 * Typed error classes for the meme-generation pipeline.
 * These replace untagged `throw new Error(...)` calls and make every
 * function's failure modes explicit in its return type signature.
 */

import {Data} from "effect";

export class ModerationBlockedError extends Data.TaggedError("ModerationBlockedError")<{
    readonly provider: string;
    readonly detail:   string;
}> {
    get message() { return `${this.provider} blocked by moderation: ${this.detail}`; }
}

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
    readonly provider: string;
    readonly attempts: number;
}> {
    get message() { return `${this.provider} rate-limit retries exhausted after ${this.attempts} attempts`; }
}

export class PushFailedError extends Data.TaggedError("PushFailedError")<{
    readonly attempts: number;
}> {
    get message() { return `Failed to push after ${this.attempts} attempts`; }
}

export class ModerationFailedError extends Data.TaggedError("ModerationFailedError")<{
    readonly fallbackProvider: string | null;
}> {
    get message() {
        return this.fallbackProvider == null
            ? "Blocked by moderation and no fallback provider is available"
            : `Both primary and fallback provider (${this.fallbackProvider}) were blocked by moderation`;
    }
}

export class ProviderError extends Data.TaggedError("ProviderError")<{
    readonly provider: string;
    readonly detail:   string;
}> {
    get message() { return `${this.provider} failed: ${this.detail}`; }
}

export class QuotaExhaustedError extends Data.TaggedError("QuotaExhaustedError")<{
    readonly provider: string;
    readonly detail:   string;
}> {
    get message() { return `${this.provider} is out of credits/quota: ${this.detail}`; }
}

export class AllProvidersExhaustedError extends Data.TaggedError("AllProvidersExhaustedError")<{
    readonly providers: ReadonlyArray<string>;
}> {
    get message() { return `All image providers are out of credits/quota: ${this.providers.join(", ")}`; }
}
