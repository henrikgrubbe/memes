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

export class RateLimitExhaustedError extends Data.TaggedError("RateLimitExhaustedError")<{
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

export class DoubleModerationError extends Data.TaggedError("DoubleModerationError")<{
    readonly fallbackProvider: string;
}> {
    get message() { return `Both primary and fallback provider (${this.fallbackProvider}) were blocked by moderation`; }
}

export class ProviderError extends Data.TaggedError("ProviderError")<{
    readonly provider: string;
    readonly detail:   string;
}> {
    get message() { return `${this.provider} failed: ${this.detail}`; }
}
