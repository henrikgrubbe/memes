import { describe, expect, it } from "vitest";
import { renderProviderAttempts, type HistoryEntry } from "./history.js";

describe("renderProviderAttempts", () => {
  it("renders each history status with its existing display", () => {
    const history: HistoryEntry[] = [
      { provider: "OpenAI", status: "success" },
      { provider: "xAI", status: "rate-limited" },
      {
        provider: "OpenAI",
        status: "failed",
        message: "blocked by moderation",
      },
    ];

    expect(renderProviderAttempts(history)).toEqual([
      "- OpenAI ✅",
      "- xAI ⏳ rate limited",
      "- OpenAI ❌ (blocked by moderation)",
    ]);
  });

  it("renders an empty history as an empty list", () => {
    expect(renderProviderAttempts([])).toEqual([]);
  });
});
