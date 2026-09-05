import { Context, Effect } from "effect";
import type { GenerationMetadata } from "./providers.js";
import type { HistoryEntry } from "./history.js";

export interface NotifySuccessParams {
  readonly memeId: string;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly prompt: string;
  readonly metadata?: GenerationMetadata;
}

export interface NotifySagaUpdateParams {
  readonly saga: string;
  readonly contribution: string;
  readonly updated: boolean;
}

// Deep interface: callers describe what happened; delivery orchestration
// remains behind this seam.

export interface NotifierService {
  readonly notifySuccess: (params: NotifySuccessParams) => Effect.Effect<void>;
  readonly notifySagaUpdate: (
    params: NotifySagaUpdateParams,
  ) => Effect.Effect<void>;
  readonly notifyFailure: (
    message: string,
    closeNotPlanned?: boolean,
    history?: ReadonlyArray<HistoryEntry>,
  ) => Effect.Effect<void>;
}

export class NotifierServiceTag extends Context.Tag("NotifierService")<
  NotifierServiceTag,
  NotifierService
>() {}
