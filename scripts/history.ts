export type HistoryStatus = "success" | "rate-limited" | "failed";

export interface HistoryEntry {
    provider: string;
    status:   HistoryStatus;
    message?: string;
}

/** Render the shared "Provider attempts" bullet list from an attempt history. */
export function renderProviderAttempts(history: ReadonlyArray<HistoryEntry>): string[] {
    return history.map(({provider, status, message}) => {
        switch (status) {
            case "success":      return `- ${provider} ✅`;
            case "rate-limited": return `- ${provider} ⏳ rate limited`;
            default:             return `- ${provider} ❌ (${message})`;
        }
    });
}
