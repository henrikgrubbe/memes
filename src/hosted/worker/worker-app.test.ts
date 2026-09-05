import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HostedGitHubError } from "./hosted-github.js";
import { handleWorkerRequest, WorkerProcessorTag } from "./worker-app.js";
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
      handleWorkerRequest("{", {
        diagnosticResponse: "success",
        mode: "live",
      }).pipe(Effect.provide(processor)),
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
      handleWorkerRequest(validRequest, {
        diagnosticResponse: "success",
        mode: "live",
      }).pipe(Effect.provide(processor)),
    );

    expect(result).toEqual({
      body: { disposition: "retry" },
      status: 503,
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
      handleWorkerRequest(validRequest, {
        diagnosticResponse: "success",
        mode: "live",
      }).pipe(Effect.provide(processor)),
    );

    expect(result).toEqual({
      body: {
        disposition: "rejected",
        error: "Queued task repository is not allowed",
      },
      status: 200,
    });
  });

  it("acknowledges diagnostics without invoking the processor", async () => {
    let calls = 0;
    const processor = Layer.succeed(WorkerProcessorTag, {
      process: () =>
        Effect.sync(() => {
          calls += 1;
          return "processed" as const;
        }),
    });

    const result = await Effect.runPromise(
      handleWorkerRequest(validRequest, {
        diagnosticResponse: "success",
        mode: "diagnostic",
      }).pipe(Effect.provide(processor)),
    );

    expect(result).toEqual({
      body: { disposition: "diagnostic-acknowledged" },
      status: 200,
    });
    expect(calls).toBe(0);
  });

  it("can request a diagnostic redelivery without side effects", async () => {
    const processor = Layer.succeed(WorkerProcessorTag, {
      process: () => Effect.die("processor must not run"),
    });

    const result = await Effect.runPromise(
      handleWorkerRequest(validRequest, {
        diagnosticResponse: "retry",
        mode: "diagnostic",
      }).pipe(Effect.provide(processor)),
    );

    expect(result).toEqual({
      body: { disposition: "diagnostic-retry" },
      status: 503,
    });
  });
});
