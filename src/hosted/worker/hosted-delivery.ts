import type { HistoryEntry } from "../../shared/history.js";
import type { GenerationMetadata } from "../../shared/providers.js";

export interface SuccessDeliveryOutcome {
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly imageUrl: string;
  readonly kind: "success";
  readonly memeId: string;
  readonly metadata?: GenerationMetadata;
  readonly generationPrompt?: string;
  readonly prompt: string;
  readonly provider: string;
}

interface SagaDeliveryOutcome {
  readonly contribution: string;
  readonly kind: "saga-updated";
  readonly saga: string;
  readonly updated: boolean;
}

interface SagaContextDeliveryOutcome {
  readonly canon: string;
  readonly kind: "saga-context";
  readonly saga: string;
}

export interface FailureDeliveryOutcome {
  readonly closeNotPlanned: boolean;
  readonly history?: ReadonlyArray<HistoryEntry>;
  readonly kind: "failure";
  readonly message: string;
}

export type DeliveryOutcome =
  | SuccessDeliveryOutcome
  | SagaDeliveryOutcome
  | SagaContextDeliveryOutcome
  | FailureDeliveryOutcome;
