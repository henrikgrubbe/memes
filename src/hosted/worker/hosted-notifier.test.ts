import { Effect, Exit } from "effect";
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
  slackWebhookUrl: "https://example.test/hook",
  writeSaga: "story",
};

const makeRepository = (
  record: (event: string) => void,
): HostedGitHubRepository => ({
  branch: "main",
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
    let events: ReadonlyArray<string> = [];
    let payloads: ReadonlyArray<unknown> = [];
    const outcome: DeliveryOutcome = {
      history: [{ provider: "OpenAI", status: "success" }],
      imageUrl: "https://images.example/memes/meme-1.jpg",
      kind: "success",
      memeId: "meme-1",
      prompt: "Prompt",
      provider: "OpenAI",
    };

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
      { content_url: outcome.imageUrl, status: "success" },
    ]);
    expect(events.join("\n")).toContain(outcome.imageUrl);
    expect(events.join("\n")).not.toContain("committed");
    expect(events.at(-1)).toBe("close:completed");
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

  it("uses the failure contract and not-planned close reason", async () => {
    let events: ReadonlyArray<string> = [];
    const outcome: DeliveryOutcome = {
      closeNotPlanned: true,
      kind: "failure",
      message: "Blocked",
    };

    await Effect.runPromise(
      deliverHostedCompletion(
        config,
        outcome,
        makeRepository((event) => {
          events = [...events, event];
        }),
        { post: () => Effect.void },
      ),
    );

    expect(events).toContain("close:not_planned");
  });
});
