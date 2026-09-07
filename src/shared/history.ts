export interface HistoryEntry {
  readonly provider: string;
  readonly status: "success" | "rate-limited" | "failed";
  readonly message?: string;
}
