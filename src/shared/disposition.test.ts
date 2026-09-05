import { describe, expect, it } from "vitest";
import {
  AllProvidersExhaustedError,
  ModerationFailedError,
  ProviderError,
} from "./errors.js";
import { failureDisposition } from "./disposition.js";

describe("failureDisposition", () => {
  it("closes moderation failures as not planned", () => {
    const error = new ModerationFailedError({
      provider: "OpenAI",
      detail: "blocked",
      fallbackProvider: null,
      history: [{ provider: "OpenAI", status: "failed" }],
    });

    expect(failureDisposition(error)).toEqual({
      message: error.message,
      closeNotPlanned: true,
      history: error.history,
    });
  });

  it("leaves provider failures open while preserving history", () => {
    const error = new ProviderError({
      provider: "OpenAI",
      detail: "network error",
      history: [
        { provider: "OpenAI", status: "failed", message: "network error" },
      ],
    });

    expect(failureDisposition(error)).toEqual({
      message: error.message,
      closeNotPlanned: false,
      history: error.history,
    });
  });

  it("leaves failures without history open", () => {
    const error = new AllProvidersExhaustedError({ providers: ["OpenAI"] });

    expect(failureDisposition(error)).toEqual({
      message: error.message,
      closeNotPlanned: false,
      history: undefined,
    });
  });
});
