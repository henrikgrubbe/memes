import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { FailureDeliveryOutcome } from "./hosted-delivery.js";
import {
  makeHostedObjectStorage,
  type ObjectStorageApi,
} from "./hosted-object-storage.js";

interface StoredObject {
  readonly body: string | Uint8Array;
  readonly metadata?: Readonly<Record<string, string>>;
}

const missing = () => ({
  $metadata: { httpStatusCode: 404 },
  name: "NotFound",
});

const preconditionFailed = () => ({
  $metadata: { httpStatusCode: 412 },
  name: "PreconditionFailed",
});

const makeMemoryApi = (
  initial: Readonly<Record<string, StoredObject>> = {},
): {
  readonly api: ObjectStorageApi;
  readonly objects: Map<string, StoredObject>;
  readonly puts: ReadonlyArray<Parameters<ObjectStorageApi["putObject"]>[0]>;
} => {
  const objects = new Map(Object.entries(initial));
  let puts: ReadonlyArray<Parameters<ObjectStorageApi["putObject"]>[0]> = [];
  return {
    api: {
      getObject: ({ key }) => {
        const object = objects.get(key);
        if (object == null) {
          return Promise.reject(missing());
        }
        return Promise.resolve(String(object.body));
      },
      headObject: ({ key }) => {
        const object = objects.get(key);
        if (object == null) {
          return Promise.reject(missing());
        }
        return Promise.resolve({ metadata: object.metadata });
      },
      putObject: (input) => {
        puts = [...puts, input];
        if (objects.has(input.key)) {
          return Promise.reject(preconditionFailed());
        }
        objects.set(input.key, {
          body: input.body,
          metadata: input.metadata,
        });
        return Promise.resolve();
      },
    },
    objects,
    get puts() {
      return puts;
    },
  };
};

const makeStore = (api: ObjectStorageApi) =>
  makeHostedObjectStorage({
    api,
    bucket: "bucket",
    deliveryId: "delivery-1",
    memeId: "meme-1",
    publicBaseUrl: "https://bucket.s3.nl-ams.scw.cloud/",
  });

const success = {
  history: [
    { provider: "xAI", status: "rate-limited" as const },
    { provider: "OpenAI", status: "success" as const },
  ],
  kind: "success" as const,
  memeId: "meme-1",
  metadata: {
    costCents: 0.108,
    revisedPrompt: "A revised prompt that is intentionally not persisted",
    usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
  },
  prompt: "A meme",
  provider: "OpenAI",
};

describe("hosted Object Storage", () => {
  it("publishes immutable JPEGs conditionally with compact retry metadata", async () => {
    const memory = makeMemoryApi();
    const outcome = await Effect.runPromise(
      makeStore(memory.api).publishImage({
        image: Buffer.from("jpeg"),
        outcome: success,
      }),
    );

    expect(outcome.imageUrl).toBe(
      "https://bucket.s3.nl-ams.scw.cloud/memes/meme-1.jpg",
    );
    expect(memory.puts).toHaveLength(1);
    expect(memory.puts[0]).toMatchObject({
      bucket: "bucket",
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "image/jpeg",
      ifNoneMatch: "*",
      key: "memes/meme-1.jpg",
      metadata: {
        "meme-cost-microcents": "108000",
        "meme-input-tokens": "12",
        "meme-output-tokens": "34",
        "meme-result-version": "1",
        "meme-total-tokens": "46",
      },
    });
    expect(memory.puts[0]?.metadata?.["meme-provider"]).toBe("T3BlbkFJ");
    expect(JSON.stringify(memory.puts[0]?.metadata)).not.toContain(
      "revised prompt",
    );
  });

  it("reconstructs a degraded success from image metadata", async () => {
    const memory = makeMemoryApi();
    const store = makeStore(memory.api);
    await Effect.runPromise(
      store.publishImage({ image: Buffer.from("jpeg"), outcome: success }),
    );

    const outcome = await Effect.runPromise(store.getOutcome("Current prompt"));

    expect(outcome).toEqual({
      history: [{ provider: "OpenAI", status: "success" }],
      imageUrl: "https://bucket.s3.nl-ams.scw.cloud/memes/meme-1.jpg",
      kind: "success",
      memeId: "meme-1",
      metadata: {
        costCents: 0.108,
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
      },
      prompt: "Current prompt",
      provider: "OpenAI",
    });
  });

  it("treats a concurrent 412 image write as a successful publication", async () => {
    const winnerMetadata = {
      "meme-provider": "eEFJ",
      "meme-result-version": "1",
    };
    let heads = 0;
    const api: ObjectStorageApi = {
      getObject: () => Promise.reject(missing()),
      headObject: () => {
        heads += 1;
        return Promise.resolve({ metadata: winnerMetadata });
      },
      putObject: () => Promise.reject(preconditionFailed()),
    };

    const outcome = await Effect.runPromise(
      makeStore(api).publishImage({
        image: Buffer.from("loser"),
        outcome: success,
      }),
    );

    expect(heads).toBe(1);
    expect(outcome.provider).toBe("xAI");
    expect(outcome.history).toEqual([{ provider: "xAI", status: "success" }]);
  });

  it.each([
    ["missing", undefined],
    [
      "malformed",
      {
        "meme-cost-microcents": "-5",
        "meme-provider": "____",
        "meme-result-version": "1",
      },
    ],
  ])(
    "uses a safe degraded success for %s image metadata",
    async (_name, metadata) => {
      const memory = makeMemoryApi({
        "memes/meme-1.jpg": { body: Buffer.from("jpeg"), metadata },
      });

      const outcome = await Effect.runPromise(
        makeStore(memory.api).getOutcome("Current prompt"),
      );

      expect(outcome).toMatchObject({
        history: [{ provider: "unknown", status: "success" }],
        kind: "success",
        provider: "unknown",
      });
      expect(outcome).not.toHaveProperty("metadata");
    },
  );

  it("stores terminal outcomes privately and resumes them", async () => {
    const memory = makeMemoryApi();
    const store = makeStore(memory.api);
    const failure: FailureDeliveryOutcome = {
      closeNotPlanned: false,
      history: [{ provider: "OpenAI", status: "failed" }],
      kind: "failure",
      message: "Provider unavailable",
    };

    await Effect.runPromise(store.recordTerminalFailure("Prompt", failure));
    const resumed = await Effect.runPromise(store.getOutcome("Prompt"));

    expect(resumed).toEqual(failure);
    expect(memory.puts).toHaveLength(1);
    expect(memory.puts[0]).toMatchObject({
      cacheControl: "no-store",
      contentType: "application/json",
      ifNoneMatch: "*",
      key: "terminal-outcomes/meme-1.json",
    });
  });
});
