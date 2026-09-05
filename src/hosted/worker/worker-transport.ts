import { Data, Effect, Schema } from "effect";
import { MemeRequestTask } from "../task.js";

export class WorkerMessageError extends Data.TaggedError("WorkerMessageError")<{
  readonly detail: string;
}> {
  public get message(): string {
    return this.detail;
  }
}

const QueueEnvelope = Schema.Struct({
  body: Schema.Union(Schema.String, MemeRequestTask),
});

const QueueInput = Schema.Union(MemeRequestTask, QueueEnvelope);
const decodeInput = Schema.decodeUnknown(Schema.parseJson(QueueInput));
const decodeEmbeddedTask = Schema.decodeUnknown(
  Schema.parseJson(MemeRequestTask),
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
    Effect.filterOrElse(
      (input): input is MemeRequestTask => "deliveryId" in input,
      (envelope) =>
        typeof envelope.body === "string"
          ? decodeEmbeddedTask(envelope.body).pipe(
              Effect.mapError(invalidMessage),
            )
          : Effect.succeed(envelope.body),
    ),
  );
