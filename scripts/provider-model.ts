import type { Effect } from "effect";
import type {
  ModerationBlockedError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "./errors.js";
import type { HistoryEntry } from "./history.js";

export interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

export interface ModelConfig {
  readonly model: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly pricing?: ModelPricing;
  readonly label?: string;
}

export interface ProviderConfig {
  readonly name: string;
  readonly envKey: string;
  readonly baseURL?: string;
  readonly models: ReadonlyArray<ModelConfig>;
}

export interface UsageEntry {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface GenerationMetadata {
  readonly revisedPrompt?: string;
  readonly usage?: UsageEntry;
  readonly costCents?: number;
}

export interface GenerationResult {
  readonly buffer: Buffer;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly metadata?: GenerationMetadata;
}

export type ProviderFn = (
  prompt: string,
  user?: string,
) => Effect.Effect<
  GenerationResult,
  ModerationBlockedError | RateLimitError | ProviderError | QuotaExhaustedError
>;

export function computeCostCents(
  usage: UsageEntry,
  pricing: ModelPricing,
): number {
  return (
    ((usage.inputTokens * pricing.inputPerMillion +
      usage.outputTokens * pricing.outputPerMillion) /
      1_000_000) *
    100
  );
}
