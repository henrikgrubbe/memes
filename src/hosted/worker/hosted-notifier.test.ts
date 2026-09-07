import { Duration, Effect, Exit } from "effect";
import * as TestClock from "effect/TestClock";
import * as TestContext from "effect/TestContext";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../shared/config.js";
import type { DeliveryOutcome } from "./hosted-delivery.js";
import type { HostedGitHubRepository } from "./hosted-github.js";
import { deliverHostedCompletion, makeSlackSender } from "./hosted-notifier.js";

const config: AppConfig = {
  channel: "C123",
  issueNumber: "42",
  memePrompt: "Prompt",
  readSaga: null,
  repo: "owner/repo",
  requester: "U123",
  slackLink: "https://example.test/thread",
  writeSaga: "story",
  requestedAt: null,
};

const makeRepository = (
  record: (event: string) => void,
  branch = "main",
): HostedGitHubRepository => ({
  branch,
  closeIssue: (reason) =>
    Effect.sync(() => {
      record(`close:${reason ?? "completed"}`);
    }),
  commentOnce: (body) =>
    Effect.sync(() => {
      record(`comment:${body}`);
    }),
  foldSaga: () => Effect.succeed(true),
  memeId: "meme-1",
  readText: () => Effect.succeed(null),
});

const captureCompletion = (
  outcome: DeliveryOutcome,
  requestConfig: AppConfig = config,
  branch = "main",
) => {
  let events: ReadonlyArray<string> = [];
  let payloads: ReadonlyArray<unknown> = [];
  return Effect.runPromise(
    deliverHostedCompletion(
      requestConfig,
      outcome,
      makeRepository((event) => {
        events = [...events, event];
      }, branch),
      {
        post: (payload) =>
          Effect.sync(() => {
            payloads = [...payloads, payload];
          }),
      },
    ),
  ).then(() => ({ events, payloads }));
};

describe("hosted notifier", () => {
  it("posts Slack payloads without curl", async () => {
    let postedBody = "";
    const sender = makeSlackSender({
      fetch: (_input, init) => {
        postedBody = String(init?.body);
        return Promise.resolve(new Response("", { status: 200 }));
      },
      webhookUrl: "https://example.test/hook",
    });

    await Effect.runPromise(sender.post({ status: "success" }));

    expect(postedBody).toContain('"status":"success"');
  });

  it("surfaces a non-successful Slack response without response contents", async () => {
    const sender = makeSlackSender({
      fetch: () => Promise.resolve(new Response("secret", { status: 500 })),
      webhookUrl: "https://example.test/hook",
    });

    const exit = await Effect.runPromise(
      sender.post({ status: "failure" }).pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("HTTP 500");
      expect(String(exit.cause)).not.toContain("secret");
    }
  });

  it("uses the permanent Object Storage URL without claiming a GitHub commit", async () => {
    const outcome: DeliveryOutcome = {
      history: [{ provider: "OpenAI", status: "success" }],
      imageUrl: "https://images.example/memes/meme-1.jpg",
      kind: "success",
      memeId: "meme-1",
      prompt: "Prompt",
      provider: "OpenAI",
    };

    const { events, payloads } = await captureCompletion(outcome);

    expect(payloads).toEqual([
      {
        status: "success",
        content_url: outcome.imageUrl,
        title: "Prompt",
        requester: "U123",
        channel: "C123",
        error: "",
        provider: "OpenAI",
        write_saga: "story",
      },
    ]);
    expect(events.join("\n")).toContain(outcome.imageUrl);
    expect(events.join("\n")).not.toContain("committed");
    expect(events.join("\n")).not.toContain("**Estimated cost:**");
    expect(events.join("\n")).not.toContain("**Usage:**");
    expect(events.at(-1)).toBe("close:completed");
  });

  it("renders generation details, attempts, usage, cost, and Saga fields", async () => {
    const generationPrompt = [
      "Background for continuity:",
      "Henrik lives on a farm.",
      "",
      "Current request - depict this now:",
      "Henrik checks the `meme` machine.",
    ].join("\n");
    const outcome: DeliveryOutcome = {
      generationPrompt,
      history: [
        { provider: "xAI", status: "rate-limited" },
        { provider: "OpenAI", status: "success" },
      ],
      imageUrl: "https://images.example/memes/meme-1.jpg",
      kind: "success",
      memeId: "meme-1",
      metadata: {
        revisedPrompt: "A revised `prompt`",
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
        costCents: 0.108,
      },
      prompt: "Henrik checks the `meme` machine.",
      provider: "OpenAI",
    };

    const { events, payloads } = await captureCompletion(outcome, {
      ...config,
      readSaga: "original",
      writeSaga: "sequel",
    });
    const comments = events.filter((event) => event.startsWith("comment:"));

    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(
      "<summary><strong>Full generation prompt</strong></summary>",
    );
    expect(comments[0]).toContain(generationPrompt);
    expect(comments[0]).toContain(
      "**Requested prompt:** ``Henrik checks the `meme` machine.``",
    );
    expect(comments[0]).toContain("**Revised prompt:** ``A revised `prompt```");
    expect(comments[0]).toContain(
      "**Usage:** 12 input, 34 output, 46 total tokens",
    );
    expect(comments[0]).toContain("**Estimated cost:** 0.108¢");
    expect(comments[0]).toContain("- xAI ⏳ rate limited");
    expect(payloads).toEqual([
      expect.objectContaining({
        cost_cents: "0.108¢",
        read_saga: "original",
        status: "success",
        write_saga: "sequel",
      }),
    ]);
  });

  it("uses the Saga status contract and closes a successful Saga issue", async () => {
    let events: ReadonlyArray<string> = [];
    const outcome: DeliveryOutcome = {
      contribution: "New beat",
      kind: "saga-updated",
      saga: "story",
      updated: true,
    };
    let payloads: ReadonlyArray<unknown> = [];

    await Effect.runPromise(
      deliverHostedCompletion(
        config,
        outcome,
        makeRepository((event) => {
          events = [...events, event];
        }),
        {
          post: (payload) =>
            Effect.sync(() => {
              payloads = [...payloads, payload];
            }),
        },
      ),
    );

    expect(payloads).toMatchObject([
      { status: "saga-updated", write_saga: "story" },
    ]);
    expect(events.at(-1)).toBe("close:completed");
  });

  it("keeps a failed Saga update open and links successful updates to the configured branch", async () => {
    const failed: DeliveryOutcome = {
      contribution: "The cats cancel the robbery.",
      kind: "saga-updated",
      saga: "heist",
      updated: false,
    };
    const succeeded = { ...failed, updated: true } as const;

    const failedCapture = await captureCompletion(failed);
    const succeededCapture = await captureCompletion(
      succeeded,
      config,
      "sagas",
    );

    expect(failedCapture.events.join("\n")).toContain(
      "The issue remains open.",
    );
    expect(
      failedCapture.events.some((event) => event.startsWith("close:")),
    ).toBe(false);
    expect(failedCapture.payloads).toEqual([
      expect.objectContaining({
        content_url: "",
        status: "saga-update-failed",
      }),
    ]);
    expect(succeededCapture.payloads).toEqual([
      expect.objectContaining({
        content_url:
          "https://github.com/owner/repo/blob/sagas/context/heist.md",
        status: "saga-updated",
      }),
    ]);
  });

  it("uses the failure contract and not-planned close reason", async () => {
    const outcome: DeliveryOutcome = {
      closeNotPlanned: true,
      kind: "failure",
      message: "Blocked",
    };

    const { events, payloads } = await captureCompletion(outcome);

    expect(payloads).toEqual([
      {
        status: "failure",
        content_url: "",
        title: "Prompt",
        requester: "U123",
        channel: "C123",
        error: "Blocked",
        write_saga: "story",
      },
    ]);
    expect(events.join("\n")).not.toContain("**Provider attempts:**");
    expect(events).toContain("close:not_planned");
  });

  it("does not render provider attempts for an empty history", async () => {
    const outcome: DeliveryOutcome = {
      closeNotPlanned: false,
      history: [],
      kind: "failure",
      message: "Generation failed",
    };

    const { events } = await captureCompletion(outcome);

    expect(events.join("\n")).not.toContain("**Provider attempts:**");
    expect(events.some((event) => event.startsWith("close:"))).toBe(false);
  });

  it("renders failure attempts and Saga fields without closing retryable failures", async () => {
    const outcome: DeliveryOutcome = {
      closeNotPlanned: false,
      history: [
        {
          provider: "OpenAI",
          status: "failed",
          message: "blocked by moderation",
        },
      ],
      kind: "failure",
      message: "Generation failed",
    };

    const { events, payloads } = await captureCompletion(outcome, {
      ...config,
      readSaga: "original",
      writeSaga: "sequel",
    });

    expect(events.join("\n")).toContain("**Provider attempts:**");
    expect(events.join("\n")).toContain("- OpenAI ❌ (blocked by moderation)");
    expect(events.some((event) => event.startsWith("close:"))).toBe(false);
    expect(payloads).toEqual([
      expect.objectContaining({
        error: "Generation failed",
        read_saga: "original",
        status: "failure",
        write_saga: "sequel",
      }),
    ]);
  });
});

describe("hosted notifier elapsed time", () => {
  const successOutcome: DeliveryOutcome = {
    history: [{ provider: "OpenAI", status: "success" }],
    imageUrl: "https://images.example/memes/meme-1.jpg",
    kind: "success",
    memeId: "meme-1",
    prompt: "Prompt",
    provider: "OpenAI",
  };

  // TestClock starts at epoch 0, so a task stamped at epoch 0 plus a fixed
  // advance gives an exact, non-flaky elapsed time.
  const captureAfter = (
    advanceMillis: number,
    outcome: DeliveryOutcome,
    requestedAt: string | null,
  ) => {
    let events: ReadonlyArray<string> = [];
    let payloads: ReadonlyArray<unknown> = [];
    const test = Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(advanceMillis));
      yield* deliverHostedCompletion(
        { ...config, requestedAt },
        outcome,
        makeRepository((event) => {
          events = [...events, event];
        }),
        {
          post: (payload) =>
            Effect.sync(() => {
              payloads = [...payloads, payload];
            }),
        },
      );
    });
    return Effect.runPromise(
      test.pipe(Effect.provide(TestContext.TestContext)),
    ).then(() => ({ events, payloads }));
  };

  const epoch = "1970-01-01T00:00:00.000Z";

  it("reports elapsed time in the issue comment and the Slack payload", async () => {
    const { events, payloads } = await captureAfter(
      90_000,
      successOutcome,
      epoch,
    );

    expect(events.join("\n")).toContain("**Took:** 1m 30s");
    expect(payloads).toEqual([
      expect.objectContaining({ duration_seconds: 90 }),
    ]);
  });

  it("formats sub-minute, multi-minute, and multi-hour durations", async () => {
    const seconds = await captureAfter(42_000, successOutcome, epoch);
    expect(seconds.events.join("\n")).toContain("**Took:** 42s");

    const hours = await captureAfter(7_500_000, successOutcome, epoch);
    expect(hours.events.join("\n")).toContain("**Took:** 2h 5m");
  });

  it("reports elapsed time on failures too", async () => {
    const { events, payloads } = await captureAfter(
      30_000,
      { closeNotPlanned: false, kind: "failure", message: "Generation failed" },
      epoch,
    );

    expect(events.join("\n")).toContain("**Took:** 30s");
    expect(payloads).toEqual([
      expect.objectContaining({ duration_seconds: 30 }),
    ]);
  });

  it("omits timing when the task carries no requestedAt stamp", async () => {
    const { events, payloads } = await captureAfter(
      90_000,
      successOutcome,
      null,
    );

    expect(events.join("\n")).not.toContain("**Took:**");
    expect(payloads[0]).not.toHaveProperty("duration_seconds");
  });

  it("omits timing rather than rendering a negative or nonsense duration", async () => {
    const unparseable = await captureAfter(
      90_000,
      successOutcome,
      "not-a-timestamp",
    );
    expect(unparseable.events.join("\n")).not.toContain("**Took:**");

    const skewed = await captureAfter(
      0,
      successOutcome,
      "1970-01-01T00:01:00.000Z",
    );
    expect(skewed.events.join("\n")).not.toContain("**Took:**");
    expect(skewed.payloads[0]).not.toHaveProperty("duration_seconds");
  });
});
