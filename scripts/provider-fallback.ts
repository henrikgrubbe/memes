import { Effect, Random } from "effect";
import {
  AllProvidersExhaustedError,
  ModerationBlockedError,
  ModerationFailedError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "./errors.js";
import type { HistoryEntry } from "./history.js";
import type { GenerationResult, ProviderFn } from "./provider-model.js";

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

function runModerationFallback(
  fallbackName: string,
  primary: string,
  primaryError: ModerationBlockedError,
  skipped: ReadonlyArray<HistoryEntry>,
  fallback: ProviderFn | null,
  prompt: string,
  user?: string,
): Effect.Effect<GenerationResult, GenerateError> {
  return Effect.gen(function* () {
    const priorHistory = [
      ...skipped,
      failedAttempt(primary, primaryError.message),
    ];
    const moderationFailure = (
      fallbackProvider: string | null,
      fallbackDetail?: string,
      fallbackEntry?: HistoryEntry,
    ) =>
      new ModerationFailedError({
        provider: primaryError.provider,
        detail: primaryError.detail,
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
      `Moderation block on ${primary} - falling back to ${fallbackName}...`,
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

function tryPrimaries(
  primaries: ProviderPool,
  remaining: ReadonlyArray<string>,
  skipped: ReadonlyArray<HistoryEntry>,
  fallbackName: string,
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

    return yield* withAttemptHistory(
      primaries[primary](prompt, user),
      skipped,
      primary,
    ).pipe(
      Effect.map((result) => ({
        ...result,
        history: [...skipped, ...result.history],
      })),
      Effect.catchTags({
        QuotaExhaustedError: (error) =>
          Effect.logWarning(
            `${primary} is out of credits/quota - skipping. ${error.detail}`,
          ).pipe(
            Effect.zipRight(
              tryPrimaries(
                primaries,
                rest,
                error.history ?? skipped,
                fallbackName,
                fallback,
                prompt,
                user,
              ),
            ),
          ),
        ModerationBlockedError: (error) =>
          runModerationFallback(
            fallbackName,
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

export function generateWithFallback(
  primaries: ProviderPool,
  fallbackName: string,
  fallback: ProviderFn | null,
  prompt: string,
  user?: string,
): Effect.Effect<GenerationResult, GenerateError> {
  return tryPrimaries(
    primaries,
    Object.keys(primaries),
    [],
    fallbackName,
    fallback,
    prompt,
    user,
  );
}
