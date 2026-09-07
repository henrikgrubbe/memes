import { createHmac } from "node:crypto";
import { DateTime, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  handleGitHubWebhook,
  makeWebhookQueueLayer,
  verifyGitHubSignature,
  WebhookQueueError,
  WebhookRequestError,
} from "./github-webhook.js";
import { failureOfType } from "../../shared/test-support.js";
import type { MemeRequestTask } from "../task.js";

const secret = "test-secret";
const issueBody = [
  "Sender: U123",
  "Channel: C123",
  "Message: A cat on a bike",
  "Link: https://slack.example/message",
].join("\n");
const payload = JSON.stringify({
  action: "opened",
  issue: { number: 42, body: issueBody, labels: [] },
  repository: { full_name: "owner/repo" },
});
const signature = (body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const run = (
  body = payload,
  options: {
    readonly deliveryId?: string;
    readonly event?: string;
    readonly signature?: string;
  } = {},
) => {
  const tasks: Array<MemeRequestTask> = [];
  const layer = makeWebhookQueueLayer({
    enqueue: (task) =>
      Effect.sync(() => {
        tasks.push(task);
      }),
  });
  const effect = handleGitHubWebhook(secret, {
    body,
    deliveryId: options.deliveryId ?? "delivery-1",
    event: options.event ?? "issues",
    signature: options.signature ?? signature(body),
  });

  return Effect.runPromise(
    effect.pipe(Effect.provide(layer), Effect.exit),
  ).then((exit) => ({ exit, tasks }));
};

describe("verifyGitHubSignature", () => {
  it("accepts the matching sha256 signature", () => {
    expect(verifyGitHubSignature(secret, payload, signature(payload))).toBe(
      true,
    );
  });

  it("rejects missing, malformed, and mismatched signatures", () => {
    expect(verifyGitHubSignature(secret, payload, undefined)).toBe(false);
    expect(verifyGitHubSignature(secret, payload, "sha256=xyz")).toBe(false);
    expect(verifyGitHubSignature(secret, payload, signature("different"))).toBe(
      false,
    );
  });
});

describe("handleGitHubWebhook", () => {
  it("queues opened issues with the GitHub delivery id", async () => {
    const { exit, tasks } = await run();

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({ status: 202, disposition: "queued" });
    }
    expect(tasks).toEqual([
      {
        deliveryId: "delivery-1",
        issueNumber: "42",
        issueBody,
        repo: "owner/repo",
        requestedAt: expect.any(String),
      },
    ]);
  });

  it("stamps requestedAt at enqueue time rather than reusing issue.created_at", async () => {
    // issue.created_at is the *original* creation time, so a reopened issue
    // would report a wildly inflated duration. The stamp must be "now".
    const before = DateTime.toEpochMillis(DateTime.unsafeNow());
    const { tasks } = await run();
    const after = DateTime.toEpochMillis(DateTime.unsafeNow());

    const requestedAt = tasks[0]?.requestedAt;
    expect(requestedAt).toBeDefined();
    const stamped = DateTime.toEpochMillis(
      DateTime.unsafeMake(String(requestedAt)),
    );
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(after + 1000);
    expect(String(requestedAt)).not.toContain("2020");
  });

  it("rejects an invalid signature before queueing", async () => {
    const { exit, tasks } = await run(payload, {
      signature: signature("different"),
    });

    expect(failureOfType(exit, WebhookRequestError).status).toBe(401);
    expect(tasks).toEqual([]);
  });

  it("ignores non-issue events and unsupported issue actions", async () => {
    const ping = await run("{}", {
      event: "ping",
      signature: signature("{}"),
    });
    const editedBody = JSON.stringify({
      action: "edited",
      issue: { number: 42, body: issueBody, labels: [] },
      repository: { full_name: "owner/repo" },
    });
    const edited = await run(editedBody);

    expect(Exit.isSuccess(ping.exit) && ping.exit.value.disposition).toBe(
      "ignored",
    );
    expect(Exit.isSuccess(edited.exit) && edited.exit.value.disposition).toBe(
      "ignored",
    );
    expect([...ping.tasks, ...edited.tasks]).toEqual([]);
  });

  it("rejects an issue webhook without a delivery id", async () => {
    const { exit } = await run(payload, { deliveryId: "" });

    expect(failureOfType(exit, WebhookRequestError).status).toBe(400);
  });

  it("rejects webhook data that violates the shared queue task contract", async () => {
    const invalidRepository = JSON.stringify({
      action: "opened",
      issue: { number: 42, body: issueBody, labels: [] },
      repository: { full_name: "not-a-repository" },
    });
    const { exit, tasks } = await run(invalidRepository);

    expect(failureOfType(exit, WebhookRequestError).status).toBe(400);
    expect(tasks).toEqual([]);
  });

  it("rejects malformed issue payloads", async () => {
    const { exit, tasks } = await run("{");

    expect(failureOfType(exit, WebhookRequestError).message).toBe(
      "Invalid issue webhook payload",
    );
    expect(tasks).toEqual([]);
  });

  it("rejects issues without a body", async () => {
    const missingBody = JSON.stringify({
      action: "opened",
      issue: { number: 42, body: null },
      repository: { full_name: "owner/repo" },
    });
    const { exit, tasks } = await run(missingBody);

    expect(failureOfType(exit, WebhookRequestError).message).toBe(
      "Issue body is required",
    );
    expect(tasks).toEqual([]);
  });

  it("surfaces queue failures", async () => {
    const queueError = new WebhookQueueError({ detail: "queue unavailable" });
    const exit = await Effect.runPromise(
      handleGitHubWebhook(secret, {
        body: payload,
        deliveryId: "delivery-1",
        event: "issues",
        signature: signature(payload),
      }).pipe(
        Effect.provide(
          makeWebhookQueueLayer({
            enqueue: () => Effect.fail(queueError),
          }),
        ),
        Effect.exit,
      ),
    );

    expect(failureOfType(exit, WebhookQueueError).message).toBe(
      "queue unavailable",
    );
  });
});
