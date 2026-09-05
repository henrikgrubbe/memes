import { Schema } from "effect";

export const MemeRequestTask = Schema.Struct({
  deliveryId: Schema.NonEmptyTrimmedString,
  issueBody: Schema.String.pipe(Schema.pattern(/\S/)),
  issueNumber: Schema.String.pipe(Schema.pattern(/^[1-9]\d*$/)),
  repo: Schema.String.pipe(Schema.pattern(/^[^/\s]+\/[^/\s]+$/)),
});

export type MemeRequestTask = Schema.Schema.Type<typeof MemeRequestTask>;
