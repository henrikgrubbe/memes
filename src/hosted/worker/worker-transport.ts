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
  body: Schema.String,
});

const decodeEnvelope = Schema.decodeUnknown(Schema.parseJson(QueueEnvelope));
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
  decodeEnvelope(requestBody).pipe(
    Effect.mapError(invalidMessage),
    Effect.flatMap((envelope) =>
      decodeEmbeddedTask(envelope.body).pipe(Effect.mapError(invalidMessage)),
    ),
  );
