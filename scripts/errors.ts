/**
 * Typed error classes for the meme-generation pipeline.
 * These replace untagged `throw new Error(...)` calls and make every
 * function's failure modes explicit in its return type signature.
 */

export class EnvMissingError {
  readonly _tag = "EnvMissingError";
  constructor(readonly key: string) {}
  get message() { return `Missing environment variable: ${this.key}`; }
}

export class IssueBodyMissingFieldError {
  readonly _tag = "IssueBodyMissingFieldError";
  constructor(readonly field: string) {}
  get message() { return `Issue body missing required field: ${this.field}`; }
}

export class ModerationBlockedError {
  readonly _tag = "ModerationBlockedError";
  constructor(
    readonly provider: string,
    readonly detail:   string,
  ) {}
  get message() { return `${this.provider} blocked by moderation: ${this.detail}`; }
}

export class RateLimitExhaustedError {
  readonly _tag = "RateLimitExhaustedError";
  constructor(
    readonly provider: string,
    readonly attempts: number,
  ) {}
  get message() { return `${this.provider} rate-limit retries exhausted after ${this.attempts} attempts`; }
}

export class ExecError {
  readonly _tag = "ExecError";
  constructor(
    readonly cmd:    string,
    readonly detail: string,
  ) {}
  get message() { return `Command failed: ${this.cmd}\n${this.detail}`; }
}

export class PushFailedError {
  readonly _tag = "PushFailedError";
  constructor(readonly attempts: number) {}
  get message() { return `Failed to push after ${this.attempts} attempts`; }
}

export class DoubleModerationError {
  readonly _tag = "DoubleModerationError";
  constructor(readonly fallbackProvider: string) {}
  get message() { return `Both primary and fallback provider (${this.fallbackProvider}) were blocked by moderation`; }
}

export class ProviderError {
  readonly _tag = "ProviderError";
  constructor(
    readonly provider: string,
    readonly detail:   string,
  ) {}
  get message() { return `${this.provider} failed: ${this.detail}`; }
}
