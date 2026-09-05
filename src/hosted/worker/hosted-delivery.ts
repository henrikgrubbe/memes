import type { HistoryEntry } from "../../shared/history.js";
import type { GenerationMetadata } from "../../shared/providers.js";

export interface SuccessDeliveryOutcome {
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly imageUrl: string;
  readonly kind: "success";
  readonly memeId: string;
  readonly metadata?: GenerationMetadata;
  readonly prompt: string;
  readonly provider: string;
}

export interface SagaDeliveryOutcome {
  readonly contribution: string;
  readonly kind: "saga-updated";
  readonly saga: string;
  readonly updated: boolean;
}

export interface FailureDeliveryOutcome {
  readonly closeNotPlanned: boolean;
  readonly history?: ReadonlyArray<HistoryEntry>;
  readonly kind: "failure";
  readonly message: string;
}

export type DeliveryOutcome =
  SuccessDeliveryOutcome | SagaDeliveryOutcome | FailureDeliveryOutcome;
