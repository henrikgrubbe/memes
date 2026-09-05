import { Schema } from "effect";

export const MemeRequestTask = Schema.Struct({
  deliveryId: Schema.String,
  issueNumber: Schema.String,
  issueBody: Schema.String,
  repo: Schema.String,
});

export type MemeRequestTask = Schema.Schema.Type<typeof MemeRequestTask>;
