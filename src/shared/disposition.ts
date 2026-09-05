import type { HistoryEntry } from "./history.js";

export interface FailureDisposition {
  readonly message: string;
  readonly closeNotPlanned: boolean;
  readonly history?: ReadonlyArray<HistoryEntry>;
}

interface FailureLike {
  readonly _tag?: string;
  readonly message: string;
  readonly history?: ReadonlyArray<HistoryEntry>;
}

/** Translate a pipeline failure into the notification and issue disposition. */
export const failureDisposition = (error: FailureLike): FailureDisposition => ({
  message: error.message,
  closeNotPlanned: error._tag === "ModerationFailedError",
  history: error.history,
});
