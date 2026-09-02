import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  appendFallback,
  buildCompressionMessages,
  buildMemePrompt,
  buildShortenMessages,
  capCanon,
  describeModelError,
  foldCanon,
  MAX_CANON_CHARS,
  MAX_PROMPT_CHARS,
  sagaPath,
} from "./saga.js";

describe("buildMemePrompt", () => {
  it("wraps a bare prompt when no saga canon is supplied", () => {
    expect(buildMemePrompt("a cat on a bike")).toBe(
      "Make a meme: a cat on a bike.",
    );
  });

  it("ignores an empty canon", () => {
    expect(buildMemePrompt("a cat", { name: "heist", canon: "   " })).toBe(
      "Make a meme: a cat.",
    );
  });

  it("prepends the canon for continuity and keeps the meme instruction", () => {
    const prompt = buildMemePrompt("the getaway", {
      name: "heist",
      canon: "A gang of cats robs a bank.",
    });
    expect(prompt).toContain('Continuing the "heist" saga.');
    expect(prompt).toContain("A gang of cats robs a bank.");
    expect(prompt.endsWith("Make a meme: the getaway.")).toBe(true);
  });

  it("never exceeds the prompt cap, trimming the canon to fit", () => {
    const canon = "x".repeat(MAX_CANON_CHARS);
    const prompt = buildMemePrompt("short prompt", { name: "s", canon });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt.endsWith("Make a meme: short prompt.")).toBe(true);
  });

  it("drops the canon entirely when the prompt alone fills the budget", () => {
    const longPrompt = "y".repeat(MAX_PROMPT_CHARS);
    const prompt = buildMemePrompt(longPrompt, {
      name: "s",
      canon: "some canon",
    });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).not.toContain("some canon");
  });
});

describe("capCanon", () => {
  it("leaves short canon untouched", () => {
    expect(capCanon("hello")).toBe("hello");
  });

  it("truncates canon longer than the ceiling", () => {
    expect(
      capCanon("z".repeat(MAX_CANON_CHARS + 500)).length,
    ).toBeLessThanOrEqual(MAX_CANON_CHARS);
  });

  it("cuts at the last line boundary rather than mid-word", () => {
    const text = "a".repeat(MAX_CANON_CHARS - 10) + "\n" + "b".repeat(100);
    const capped = capCanon(text);
    expect(capped.length).toBeLessThanOrEqual(MAX_CANON_CHARS);
    expect(capped).toBe("a".repeat(MAX_CANON_CHARS - 10));
    expect(capped).not.toContain("b");
  });

  it("hard-cuts when the only boundary is too early to be useful", () => {
    const text = "x. " + "y".repeat(MAX_CANON_CHARS + 100); // boundary at index 1
    const capped = capCanon(text);
    expect(capped.length).toBe(MAX_CANON_CHARS);
  });
});

describe("appendFallback", () => {
  it("starts a fresh list from an empty canon", () => {
    expect(appendFallback("", "first idea")).toBe("- first idea");
  });

  it("appends a new bullet to an existing canon", () => {
    expect(appendFallback("- older", "newer")).toBe("- older\n- newer");
  });

  it("caps the result at the ceiling", () => {
    expect(appendFallback("a".repeat(MAX_CANON_CHARS), "overflow").length).toBe(
      MAX_CANON_CHARS,
    );
  });
});

describe("buildCompressionMessages", () => {
  it("names the saga and the character ceiling in the system prompt", () => {
    const [system] = buildCompressionMessages("heist", "canon", "idea");
    expect(system.role).toBe("system");
    expect(system.content).toContain('saga "heist"');
    expect(system.content).toContain(String(MAX_CANON_CHARS));
  });

  it("asks for an incremental story update that can remove obsolete canon", () => {
    const [system, user] = buildCompressionMessages(
      "heist",
      "The cats plan a bank robbery.",
      "The cats cancel the robbery.",
    );
    expect(system.content).toContain(
      "correct, replace, invalidate, resolve or remove",
    );
    expect(system.content).toContain("without keeping obsolete versions");
    expect(user.content).toContain("This is the story so far:");
    expect(user.content).toContain("Now this has happened:");
    expect(user.content).toContain("Update the story");
  });

  it("requires concise, lightly structured Markdown", () => {
    const [system] = buildCompressionMessages("heist", "canon", "idea");
    expect(system.content).toContain("concise Markdown");
    expect(system.content).toContain("useful headings and short bullet");
    expect(system.content).toContain(
      "Do not use tables, deep nesting, emphasis or decorative formatting",
    );
  });

  it("marks an empty canon as the first entry and includes the new idea", () => {
    const [, user] = buildCompressionMessages(
      "heist",
      "   ",
      "a cat cracks a safe",
    );
    expect(user.content).toContain("(empty - this is the first entry)");
    expect(user.content).toContain("a cat cracks a safe");
  });

  it("includes the existing canon when present", () => {
    const [, user] = buildCompressionMessages(
      "heist",
      "prior canon text",
      "next",
    );
    expect(user.content).toContain("prior canon text");
  });
});

describe("sagaPath", () => {
  it("maps a saga name to a markdown file under the context dir", () => {
    expect(sagaPath("heist")).toBe("context/heist.md");
  });
});

describe("buildShortenMessages", () => {
  it("instructs a hard shorten under the ceiling and includes the overlong canon", () => {
    const [system, user] = buildShortenMessages("heist", "way too long canon");
    expect(system.content).toContain('saga "heist"');
    expect(system.content).toContain(String(MAX_CANON_CHARS));
    expect(system.content.toUpperCase()).toContain("SHORTER");
    expect(system.content).toContain("concise Markdown");
    expect(user.content).toContain("way too long canon");
  });
});

describe("foldCanon", () => {
  const queuedModel = (responses: Array<string | Error>) => {
    let i = 0;
    return () => {
      const r = responses[Math.min(i++, responses.length - 1)];
      return r instanceof Error ? Effect.fail(r) : Effect.succeed(r);
    };
  };
  const run = (
    responses: Array<string | Error>,
    canon = "old canon",
    prompt = "new idea",
  ) =>
    Effect.runPromise(
      foldCanon(queuedModel(responses), "heist", canon, prompt),
    );

  it("returns the model's canon unchanged when it is within budget", async () => {
    expect(await run(["a tidy canon"])).toBe("a tidy canon");
  });

  it("retries with a shorten pass when the first response overshoots", async () => {
    const result = await run([
      "x".repeat(MAX_CANON_CHARS + 500),
      "shortened canon",
    ]);
    expect(result).toBe("shortened canon");
  });

  it("clamps to the ceiling when even the shorten pass overshoots", async () => {
    const result = await run([
      "x".repeat(MAX_CANON_CHARS + 500),
      "y".repeat(MAX_CANON_CHARS + 500),
    ]);
    expect(result.length).toBeLessThanOrEqual(MAX_CANON_CHARS);
  });

  it("falls back to a raw append when the model call fails", async () => {
    const result = await run([new Error("boom")], "old canon", "new idea");
    expect(result).toBe("old canon\n- new idea");
  });

  it("clamps the first response when the shorten retry fails", async () => {
    const result = await run([
      "z".repeat(MAX_CANON_CHARS + 500),
      new Error("boom"),
    ]);
    expect(result.length).toBeLessThanOrEqual(MAX_CANON_CHARS);
    expect(result).toContain("z");
  });
});

describe("describeModelError", () => {
  it("renders an OpenAI APIError as status + code + message", () => {
    const err = {
      status: 404,
      code: "model_not_found",
      message:
        "The model `gpt-4o-mini` does not exist or you do not have access to it.",
    };
    expect(describeModelError(err)).toBe(
      "HTTP 404 [model_not_found] The model `gpt-4o-mini` does not exist or you do not have access to it.",
    );
  });

  it("reads a nested error object shape", () => {
    const err = {
      status: 403,
      error: {
        code: "insufficient_quota",
        message: "You exceeded your current quota",
      },
    };
    expect(describeModelError(err)).toBe(
      "HTTP 403 [insufficient_quota] You exceeded your current quota",
    );
  });

  it("uses the message of a plain Error", () => {
    expect(describeModelError(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-error value", () => {
    expect(describeModelError("weird")).toBe("weird");
  });
});
