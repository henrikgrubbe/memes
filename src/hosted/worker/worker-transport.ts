import { Data, Effect, Schema } from "effect";
import type { MemeRequestTask } from "../task.js";

export class WorkerMessageError extends Data.TaggedError("WorkerMessageError")<{
  readonly detail: string;
}> {
  public get message(): string {
    return this.detail;
  }
}

const ValidMemeRequestTask = Schema.Struct({
  deliveryId: Schema.NonEmptyTrimmedString,
  issueBody: Schema.NonEmptyTrimmedString,
  issueNumber: Schema.String.pipe(Schema.pattern(/^[1-9]\d*$/)),
  repo: Schema.String.pipe(Schema.pattern(/^[^/\s]+\/[^/\s]+$/)),
});

const QueueEnvelope = Schema.Struct({
  body: Schema.Union(Schema.String, ValidMemeRequestTask),
});

const QueueInput = Schema.Union(ValidMemeRequestTask, QueueEnvelope);
const decodeInput = Schema.decodeUnknown(Schema.parseJson(QueueInput));
const decodeEmbeddedTask = Schema.decodeUnknown(
  Schema.parseJson(ValidMemeRequestTask),
);

const invalidMessage = () =>
  new WorkerMessageError({
    detail: "Queue request does not contain a valid meme task",
  });

export const decodeScalewayQueueRequest = (
  requestBody: string,
): Effect.Effect<MemeRequestTask, WorkerMessageError> =>
  decodeInput(requestBody).pipe(
    Effect.mapError(invalidMessage),
    Effect.flatMap((input) => {
      if ("deliveryId" in input) {
        return Effect.succeed(input);
      }
      return typeof input.body === "string"
        ? decodeEmbeddedTask(input.body).pipe(Effect.mapError(invalidMessage))
        : Effect.succeed(input.body);
    }),
  );
