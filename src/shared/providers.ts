import OpenAI from "openai";
import { Config, Context, Effect, Layer, Option, Random } from "effect";
import type { ConfigError } from "effect/ConfigError";
import type {
  AllProvidersExhaustedError,
  ModerationFailedError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "./errors.js";
import { callWithRetry } from "./provider-call.js";
import { generateWithFallback } from "./provider-fallback.js";
import type {
  GenerationResult,
  ModelConfig,
  ProviderConfig,
  ProviderFn,
} from "./provider-model.js";

export { callWithRetry, MAX_RETRIES } from "./provider-call.js";
export {
  computeCostCents,
  type GenerationMetadata,
  type GenerationResult,
  type ModelConfig,
  type ModelPricing,
  type ProviderConfig,
  type ProviderFn,
  type UsageEntry,
} from "./provider-model.js";

export const PRIMARY_PROVIDERS: ReadonlyArray<ProviderConfig> = [
  {
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    models: [
      {
        model: "gpt-image-2",
        params: {
          size: "1024x1024",
          quality: "low",
          output_format: "jpeg",
          moderation: "low",
          output_compression: 80,
        },
        pricing: { inputPerMillion: 5, outputPerMillion: 30 },
      },
    ],
  },
];

export const MODERATION_FALLBACK_PROVIDER: ProviderConfig = {
  name: "xAI",
  envKey: "XAI_API_KEY",
  baseURL: "https://api.x.ai/v1",
  models: [
    { model: "grok-imagine-image", params: { response_format: "b64_json" } },
  ],
};

export interface ProvidersService {
  readonly generateWithFallback: (
    prompt: string,
    user?: string,
  ) => Effect.Effect<GenerationResult, GenerationError>;
}

export type GenerationError =
  | ModerationFailedError
  | AllProvidersExhaustedError
  | ProviderError
  | RateLimitError
  | QuotaExhaustedError;

export class ProvidersServiceTag extends Context.Tag("ProvidersService")<
  ProvidersServiceTag,
  ProvidersService
>() {}

const makeService = (
  primaries: Readonly<Record<string, ProviderFn>>,
  fallback: ProviderFn | null,
): ProvidersService => ({
  generateWithFallback: (prompt, user) =>
    generateWithFallback(
      primaries,
      {
        name: MODERATION_FALLBACK_PROVIDER.name,
        generate: fallback,
      },
      { prompt, ...(user == null ? {} : { user }) },
    ),
});

export const makeProvidersLayer = (
  primaries: Readonly<Record<string, ProviderFn>>,
  fallback?: ProviderFn,
): Layer.Layer<ProvidersServiceTag> =>
  Layer.succeed(ProvidersServiceTag, makeService(primaries, fallback ?? null));

export const modelLabel = (
  config: ProviderConfig,
  model: ModelConfig,
): string => model.label ?? `${config.name} (${model.model})`;

export const makeCandidates = (
  config: ProviderConfig,
  apiKey: string,
): ReadonlyArray<readonly [string, ProviderFn]> => {
  const client = new OpenAI({
    apiKey,
    ...(config.baseURL == null ? {} : { baseURL: config.baseURL }),
  });

  return config.models.map((model) => {
    const label = modelLabel(config, model);
    const generate: ProviderFn = (prompt, user) =>
      callWithRetry(
        label,
        client,
        model.model,
        model.params ?? {},
        prompt,
        user,
        model.pricing,
      );

    return [label, generate] as const;
  });
};

const loadProvider = (
  config: ProviderConfig,
): Effect.Effect<ReadonlyArray<readonly [string, ProviderFn]>, ConfigError> =>
  Config.option(Config.string(config.envKey)).pipe(
    Effect.map(
      Option.match({
        onNone: () => [],
        onSome: (apiKey) =>
          apiKey.trim() === "" ? [] : makeCandidates(config, apiKey),
      }),
    ),
  );

export const ProvidersLayer = Layer.effect(
  ProvidersServiceTag,
  Effect.gen(function* () {
    const loaded = yield* Effect.forEach(PRIMARY_PROVIDERS, loadProvider);
    const primaries = Object.fromEntries(loaded.flat());

    if (Object.keys(primaries).length === 0) {
      return yield* Effect.die(
        "No image provider configured: set at least one primary provider API key.",
      );
    }

    const fallbackCandidates = (yield* loadProvider(
      MODERATION_FALLBACK_PROVIDER,
    )).map(([, candidate]) => candidate);
    const fallback: ProviderFn | null =
      fallbackCandidates.length === 0
        ? null
        : (prompt, user) =>
            Random.choice(fallbackCandidates).pipe(
              Effect.orDie,
              Effect.flatMap((candidate) => candidate(prompt, user)),
            );

    return makeService(primaries, fallback);
  }),
);
