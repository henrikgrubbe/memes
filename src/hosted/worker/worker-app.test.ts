import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { failureOfType } from "../../shared/test-support.js";
import { HostedGitHubError } from "./hosted-github.js";
import {
  handleWorkerRequest,
  makeWorkerTaskConfig,
  WorkerProcessorTag,
} from "./worker-handler.js";
import { WorkerMessageError } from "./worker-transport.js";

const encode = Schema.encodeSync(Schema.parseJson(Schema.Unknown));

const validRequest = encode({
  body: encode({
    deliveryId: "delivery-1",
    issueBody:
      "sender: U1\nmessage: Test\nchannel: C1\nlink: https://example.test",
    issueNumber: "42",
    repo: "owner/repo",
  }),
});
const validTask = {
  deliveryId: "delivery-1",
  issueBody:
    "sender: U1\nmessage: Test\nchannel: C1\nlink: https://example.test",
  issueNumber: "42",
  repo: "owner/repo",
} as const;

describe("worker HTTP handling", () => {
  it("acknowledges permanently malformed messages without retrying", async () => {
    let calls = 0;
    const processor = Layer.succeed(WorkerProcessorTag, {
      process: () =>
        Effect.sync(() => {
          calls += 1;
          return "processed" as const;
        }),
    });

    const result = await Effect.runPromise(
      handleWorkerRequest("{").pipe(Effect.provide(processor)),
    );

    expect(result.status).toBe(200);
    expect(result.body["disposition"]).toBe("rejected");
    expect(calls).toBe(0);
  });

  it("returns a retryable status when processing fails", async () => {
    const processor = Layer.succeed(WorkerProcessorTag, {
      process: () =>
        Effect.fail(
          new HostedGitHubError({
            detail: "temporary failure",
            operation: "test",
          }),
        ),
    });

    const result = await Effect.runPromise(
      handleWorkerRequest(validRequest).pipe(Effect.provide(processor)),
    );

    expect(result).toEqual({
      body: { disposition: "retry" },
      status: 503,
    });
  });

  describe("worker task configuration", () => {
    const config = {
      allowedRepository: "owner/repo",
      slackWebhookUrl: "https://example.test/webhook",
    };

    it("rejects tasks for another repository", async () => {
      const exit = await Effect.runPromise(
        makeWorkerTaskConfig(
          { ...validTask, repo: "another/repository" },
          config,
        ).pipe(Effect.exit),
      );

      expect(failureOfType(exit, WorkerMessageError).message).toBe(
        "Queued task repository is not allowed",
      );
    });

    it("rejects invalid Slack issue bodies", async () => {
      const exit = await Effect.runPromise(
        makeWorkerTaskConfig(
          { ...validTask, issueBody: "invalid" },
          config,
        ).pipe(Effect.exit),
      );

      expect(failureOfType(exit, WorkerMessageError).message).toBe(
        "Queued issue body is invalid",
      );
    });
  });

  it("acknowledges processor-rejected tasks without retrying", async () => {
    const processor = Layer.succeed(WorkerProcessorTag, {
      process: () =>
        Effect.fail(
          new WorkerMessageError({
            detail: "Queued task repository is not allowed",
          }),
        ),
    });

    const result = await Effect.runPromise(
      handleWorkerRequest(validRequest).pipe(Effect.provide(processor)),
    );

    expect(result).toEqual({
      body: {
        disposition: "rejected",
        error: "Queued task repository is not allowed",
      },
      status: 200,
    });
  });

  it("returns a retryable status when the processor defects", async () => {
    const processor = Layer.succeed(WorkerProcessorTag, {
      process: () => Effect.die("unexpected defect"),
    });

    const result = await Effect.runPromise(
      handleWorkerRequest(validRequest).pipe(Effect.provide(processor)),
    );

    expect(result).toEqual({
      body: { disposition: "retry" },
      status: 503,
    });
  });
});
