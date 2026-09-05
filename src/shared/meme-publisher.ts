import { Context, Effect, Layer } from "effect";
import { MemePublishError } from "./errors.js";

export interface PreparedMeme {
  readonly memeId: string;
  readonly publish: (
    image: Uint8Array,
  ) => Effect.Effect<void, MemePublishError>;
}

// Callers reserve an identity before generation, then publish its image bytes.
// File layout, UUID generation, and git staging belong to the adapter rather
// than the generation pipeline.
export interface MemePublisherService {
  readonly prepare: (
    issueNumber: string,
  ) => Effect.Effect<PreparedMeme, MemePublishError>;
}

export class MemePublisherServiceTag extends Context.Tag(
  "MemePublisherService",
)<MemePublisherServiceTag, MemePublisherService>() {}

export const makeMemePublisherLayer = (
  impl: MemePublisherService,
): Layer.Layer<MemePublisherServiceTag> =>
  Layer.succeed(MemePublisherServiceTag, impl);
