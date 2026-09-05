import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { WebhookQueueError } from "./github-webhook.js";
import { makeScalewayQueue } from "./scaleway-queue.js";
import { failureOfType } from "../../shared/test-support.js";
import { MemeRequestTask } from "../task.js";

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
    const requests: Array<SendMessageCommandInput> = [];
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
        MessageBody: expect.any(String),
        MessageDeduplicationId: task.deliveryId,
        MessageGroupId: "meme-requests",
        QueueUrl: config.queueUrl,
      },
    ]);
    expect(
      Schema.decodeUnknownSync(Schema.parseJson(MemeRequestTask))(
        requests[0]?.MessageBody,
      ),
    ).toEqual(task);
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
});
