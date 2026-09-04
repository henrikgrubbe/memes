import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  WebhookQueueError,
  WebhookQueueTag,
  type MemeRequestTask,
} from "./github-webhook.js";
import { makeScalewayQueue, makeScalewayQueueLayer } from "./scaleway-queue.js";
import { failureOfType } from "./test-support.js";

const config = {
  queueUrl: "https://sqs.mnq.fr-par.scaleway.com/project-id/meme-requests.fifo",
};
const task: MemeRequestTask = {
  deliveryId: "5016556c-2c00-4f1b-b64f-8739aad2193a",
  issueNumber: "42",
  issueBody: "Sender: U123",
  repo: "owner/repo",
};

describe("makeScalewayQueue", () => {
  it("publishes a deduplicated task to the configured queue", async () => {
    const requests: Array<unknown> = [];
    const queue = makeScalewayQueue(
      {
        send: (command) => {
          requests.push(command.input);
          return Promise.resolve({});
        },
      },
      config,
    );

    await Effect.runPromise(queue.enqueue(task));

    expect(requests).toEqual([
      {
        MessageBody: JSON.stringify(task),
        MessageDeduplicationId: task.deliveryId,
        QueueUrl: config.queueUrl,
      },
    ]);
  });

  it("surfaces message publication failures", async () => {
    const queue = makeScalewayQueue(
      {
        send: () => Promise.reject(new Error("unavailable")),
      },
      config,
    );
    const exit = await Effect.runPromise(queue.enqueue(task).pipe(Effect.exit));

    expect(failureOfType(exit, WebhookQueueError).message).toContain(
      "unavailable",
    );
  });

  it("constructs a queue layer from Scaleway credentials", async () => {
    const layer = makeScalewayQueueLayer({
      accessKey: "access-key",
      endpoint: "https://sqs.mnq.fr-par.scaleway.com",
      queueUrl: config.queueUrl,
      region: "fr-par",
      secretKey: "secret-key",
    });

    const queue = await Effect.runPromise(
      WebhookQueueTag.pipe(Effect.provide(layer)),
    );

    expect(queue.enqueue).toBeTypeOf("function");
  });
});
