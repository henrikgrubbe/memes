/**
 * Typed error classes for the meme-generation pipeline.
 * These replace untagged `throw new Error(...)` calls and make every
 * function's failure modes explicit in its return type signature.
 */

import { Data } from "effect";
import type { HistoryEntry } from "./history.js";

// Terminal errors surfaced by generateWithFallback optionally carry the full
// list of provider attempts that led to the failure, so the failure notifier
// can report them just like a successful run does.

export class ModerationBlockedError extends Data.TaggedError(
  "ModerationBlockedError",
)<{
  readonly provider: string;
  readonly detail: string;
}> {
  public get message(): string {
    return `${this.provider} blocked by moderation: ${this.detail}`;
  }
}

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  readonly provider: string;
  readonly attempts: number;
  readonly history?: ReadonlyArray<HistoryEntry>;
}> {
  public get message(): string {
    return `${this.provider} rate-limit retries exhausted after ${this.attempts} attempts`;
  }
}

export class PushFailedError extends Data.TaggedError("PushFailedError")<{
  readonly attempts: number;
}> {
  public get message(): string {
    return `Failed to push after ${this.attempts} attempts`;
  }
}

export class MemePublishError extends Data.TaggedError("MemePublishError")<{
  readonly detail: string;
}> {
  public get message(): string {
    return this.detail;
  }
}

export class NotificationError extends Data.TaggedError("NotificationError")<{
  readonly detail: string;
}> {
  public get message(): string {
    return this.detail;
  }
}

export class ModerationFailedError extends Data.TaggedError(
  "ModerationFailedError",
)<{
  // The primary provider that flagged the content, and its moderation reason.
  readonly provider: string;
  readonly detail: string;
  // The fallback provider that could not rescue the request (null when none is
  // configured), plus a short note on why it couldn't help.
  readonly fallbackProvider: string | null;
  readonly fallbackDetail?: string;
  readonly history?: ReadonlyArray<HistoryEntry>;
}> {
  public get message(): string {
    const base = `${this.provider} blocked by moderation: ${this.detail}`;
    return this.fallbackProvider == null
      ? `${base} (no fallback provider available)`
      : `${base} (fallback ${this.fallbackProvider} could not help: ${this.fallbackDetail ?? "unavailable"})`;
  }
}

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly provider: string;
  readonly detail: string;
  readonly history?: ReadonlyArray<HistoryEntry>;
}> {
  public get message(): string {
    return `${this.provider} failed: ${this.detail}`;
  }
}

export class QuotaExhaustedError extends Data.TaggedError(
  "QuotaExhaustedError",
)<{
  readonly provider: string;
  readonly detail: string;
  readonly history?: ReadonlyArray<HistoryEntry>;
}> {
  public get message(): string {
    return `${this.provider} is out of credits/quota: ${this.detail}`;
  }
}

export class AllProvidersExhaustedError extends Data.TaggedError(
  "AllProvidersExhaustedError",
)<{
  readonly providers: ReadonlyArray<string>;
  readonly history?: ReadonlyArray<HistoryEntry>;
}> {
  public get message(): string {
    return `All image providers are out of credits/quota: ${this.providers.join(", ")}`;
  }
}
