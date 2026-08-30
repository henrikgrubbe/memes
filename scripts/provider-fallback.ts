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
  ModerationBlockedError | ProviderError | RateLimitError | QuotaExhaustedError;
type HistoryError = Exclude<AttemptError, ModerationBlockedError>;

interface FallbackProvider {
  readonly name: string;
  readonly generate: ProviderFn | null;
}

interface GenerationRequest {
  readonly prompt: string;
  readonly user?: string;
}

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
  fallback: FallbackProvider,
  primary: string,
  primaryError: ModerationBlockedError,
  skipped: ReadonlyArray<HistoryEntry>,
  request: GenerationRequest,
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

    const failFallback = (error: AttemptError, detail: string) =>
      Effect.fail(
        moderationFailure(
          error.provider,
          detail,
          failedAttempt(error.provider, error.message),
        ),
      );

    if (fallback.generate == null) {
      yield* Effect.log(
        `Moderation block on ${primary} - no fallback provider available.`,
      );
      return yield* moderationFailure(null);
    }

    yield* Effect.log(
      `Moderation block on ${primary} - falling back to ${fallback.name}...`,
    );

    return yield* fallback.generate(request.prompt, request.user).pipe(
      Effect.map((result) => ({
        ...result,
        history: [...priorHistory, ...result.history],
      })),
      Effect.catchTag("ModerationBlockedError", (error) =>
        failFallback(error, "also blocked by moderation"),
      ),
      Effect.catchTags({
        QuotaExhaustedError: (error) =>
          failFallback(error, "out of credits/quota"),
        RateLimitError: (error) =>
          failFallback(error, "rate-limit retries exhausted"),
        ProviderError: (error) => failFallback(error, error.detail),
      }),
    );
  });
}

function tryPrimaries(
  primaries: ProviderPool,
  remaining: ReadonlyArray<string>,
  skipped: ReadonlyArray<HistoryEntry>,
  fallback: FallbackProvider,
  request: GenerationRequest,
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
      primaries[primary](request.prompt, request.user),
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
                fallback,
                request,
              ),
            ),
          ),
        ModerationBlockedError: (error) =>
          runModerationFallback(fallback, primary, error, skipped, request),
      }),
    );
  });
}

export function generateWithFallback(
  primaries: ProviderPool,
  fallback: FallbackProvider,
  request: GenerationRequest,
): Effect.Effect<GenerationResult, GenerateError> {
  return tryPrimaries(primaries, Object.keys(primaries), [], fallback, request);
}
