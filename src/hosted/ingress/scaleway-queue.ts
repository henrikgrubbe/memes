import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Config, Effect, Layer, Schema } from "effect";
import type { DurationInput } from "effect/Duration";
import { MemeRequestTask, type MemeRequestTask as Task } from "../task.js";
import { WebhookQueueError, WebhookQueueTag } from "./github-webhook.js";

const DEFAULT_QUEUE_PUBLISH_TIMEOUT: DurationInput = "8 seconds";

interface ScalewayQueueConfig {
  readonly accessKey: string;
  readonly endpoint: string;
  readonly queueUrl: string;
  readonly region: string;
  readonly secretKey: string;
}

interface MessageClient {
  readonly send: (command: SendMessageCommand) => Promise<unknown>;
}

interface ScalewayQueueOptions {
  readonly publishTimeout?: DurationInput;
}

const encodeTask = Schema.encodeSync(Schema.parseJson(MemeRequestTask));

export const makeScalewayQueue = (
  client: MessageClient,
  config: Pick<ScalewayQueueConfig, "queueUrl">,
  options: ScalewayQueueOptions = {},
) => ({
  enqueue: (task: Task): Effect.Effect<void, WebhookQueueError> =>
    Effect.tryPromise({
      try: () =>
        client.send(
          new SendMessageCommand({
            MessageBody: encodeTask(task),
            MessageDeduplicationId: task.deliveryId,
            MessageGroupId: "meme-requests",
            QueueUrl: config.queueUrl,
          }),
        ),
      catch: (error) =>
        new WebhookQueueError({
          detail: `Scaleway Queues enqueue failed: ${String(error)}`,
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: options.publishTimeout ?? DEFAULT_QUEUE_PUBLISH_TIMEOUT,
        onTimeout: () =>
          new WebhookQueueError({
            detail: "Scaleway Queues enqueue timed out",
          }),
      }),
      Effect.asVoid,
    ),
});

const ScalewayQueueConfig = Config.all({
  accessKey: Config.string("SQS_ACCESS_KEY"),
  endpoint: Config.string("SQS_ENDPOINT"),
  queueUrl: Config.string("SQS_QUEUE_URL"),
  region: Config.string("SQS_REGION"),
  secretKey: Config.string("SQS_SECRET_KEY"),
});

export const ScalewayQueueLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* ScalewayQueueConfig;
    const client = new SQSClient({
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      endpoint: config.endpoint,
      region: config.region,
    });
    return Layer.succeed(WebhookQueueTag, makeScalewayQueue(client, config));
  }),
);
