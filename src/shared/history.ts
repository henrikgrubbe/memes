export interface HistoryEntry {
  readonly provider: string;
  readonly status: "success" | "rate-limited" | "failed";
  readonly message?: string;
}

/** Render the shared "Provider attempts" bullet list from an attempt history. */
export function renderProviderAttempts(
  history: ReadonlyArray<HistoryEntry>,
): ReadonlyArray<string> {
  return history.map(({ provider, status, message }) => {
    switch (status) {
      case "success":
        return `- ${provider} ✅`;
      case "rate-limited":
        return `- ${provider} ⏳ rate limited`;
      case "failed":
        return `- ${provider} ❌ (${message})`;
    }
  });
}
