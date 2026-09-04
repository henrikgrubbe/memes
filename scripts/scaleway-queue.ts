import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Config, Effect, Layer, Schema } from "effect";
import {
  MemeRequestTask,
  WebhookQueueError,
  WebhookQueueTag,
} from "./github-webhook.js";

export interface ScalewayQueueConfig {
  readonly accessKey: string;
  readonly endpoint: string;
  readonly queueUrl: string;
  readonly region: string;
  readonly secretKey: string;
}

interface MessageClient {
  readonly send: (command: SendMessageCommand) => Promise<unknown>;
}

const encodeTask = Schema.encodeSync(Schema.parseJson(MemeRequestTask));

export const makeScalewayQueue = (
  client: MessageClient,
  config: Pick<ScalewayQueueConfig, "queueUrl">,
) => ({
  enqueue: (task: MemeRequestTask): Effect.Effect<void, WebhookQueueError> =>
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
    }).pipe(Effect.asVoid),
});

const ScalewayQueueConfig = Config.all({
  accessKey: Config.string("SQS_ACCESS_KEY"),
  endpoint: Config.string("SQS_ENDPOINT"),
  queueUrl: Config.string("SQS_QUEUE_URL"),
  region: Config.string("SQS_REGION"),
  secretKey: Config.string("SQS_SECRET_KEY"),
});

export const makeScalewayQueueLayer = (
  config: ScalewayQueueConfig,
): Layer.Layer<WebhookQueueTag> => {
  const client = new SQSClient({
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    endpoint: config.endpoint,
    region: config.region,
  });
  return Layer.succeed(WebhookQueueTag, makeScalewayQueue(client, config));
};

export const ScalewayQueueLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* ScalewayQueueConfig;
    return makeScalewayQueueLayer(config);
  }),
);
