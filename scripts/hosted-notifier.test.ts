import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { NotificationError } from "./errors.js";
import type {
  CompletedDeliveryState,
  DeliveryOutcome,
  HostedGitHubRepository,
} from "./hosted-github.js";
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

const completed = (outcome: DeliveryOutcome): CompletedDeliveryState => ({
  deliveryId: "delivery-1",
  issueNumber: "42",
  memeId: "meme-1",
  outcome,
  repo: "owner/repo",
  slack: "pending",
  status: "completed",
  version: 1,
});

const makeRepository = (
  outcome: DeliveryOutcome,
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
  complete: () => Effect.succeed(completed(outcome)),
  contributeSaga: () => Effect.succeed(true),
  getDelivery: () => Effect.succeed(completed(outcome)),
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
      const failure = exit.cause;
      expect(String(failure)).toContain("HTTP 500");
      expect(String(failure)).not.toContain("secret");
    }
  });

  it("uses the saga status contract and closes a successful saga issue", async () => {
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
        makeRepository(outcome, (event) => {
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
        makeRepository(outcome, (event) => {
          events = [...events, event];
        }),
        { post: () => Effect.void },
      ),
    );

    expect(events).toContain("close:not_planned");
  });

  it("rejects notification before a delivery is complete", async () => {
    const repository = {
      ...makeRepository(
        {
          closeNotPlanned: false,
          kind: "failure",
          message: "failure",
        },
        () => undefined,
      ),
      getDelivery: () => Effect.succeed(null),
    };

    const exit = await Effect.runPromise(
      deliverHostedCompletion(config, repository, {
        post: () => Effect.void,
      }).pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain(
        new NotificationError({
          detail: "Delivery is not complete enough to notify",
        }).message,
      );
    }
  });
});
