import { Schema } from "effect";

export const MemeRequestTask = Schema.Struct({
  deliveryId: Schema.NonEmptyTrimmedString,
  issueBody: Schema.String.pipe(Schema.pattern(/\S/)),
  issueNumber: Schema.String.pipe(Schema.pattern(/^[1-9]\d*$/)),
  repo: Schema.String.pipe(Schema.pattern(/^[^/\s]+\/[^/\s]+$/)),
  // Optional on purpose: ingress and worker deploy independently, so a task
  // published by an older ingress must still decode in a newer worker.
  requestedAt: Schema.optional(Schema.String),
});

export type MemeRequestTask = Schema.Schema.Type<typeof MemeRequestTask>;
