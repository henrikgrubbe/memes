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
    const receipt = await Effect.runPromise(
      makeStore(memory.api).receiptFor("A meme"),
    );
    expect(receipt.status).toBe("missing");
    if (receipt.status === "recorded") {
      throw new Error("Expected a missing receipt");
    }
    const outcome = await Effect.runPromise(
      receipt.record({
        kind: "image",
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
      storageClass: "ONEZONE_IA",
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
    const missingReceipt = await Effect.runPromise(store.receiptFor("A meme"));
    expect(missingReceipt.status).toBe("missing");
    if (missingReceipt.status === "recorded") {
      throw new Error("Expected a missing receipt");
    }
    await Effect.runPromise(
      missingReceipt.record({
        kind: "image",
        image: Buffer.from("jpeg"),
        outcome: success,
      }),
    );

    const receipt = await Effect.runPromise(store.receiptFor("Current prompt"));

    expect(receipt).toEqual({
      status: "recorded",
      outcome: {
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
      },
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
        return heads === 1
          ? Promise.reject(missing())
          : Promise.resolve({ metadata: winnerMetadata });
      },
      putObject: () => Promise.reject(preconditionFailed()),
    };

    const receipt = await Effect.runPromise(
      makeStore(api).receiptFor("A meme"),
    );
    expect(receipt.status).toBe("missing");
    if (receipt.status === "recorded") {
      throw new Error("Expected a missing receipt");
    }
    const outcome = await Effect.runPromise(
      receipt.record({
        kind: "image",
        image: Buffer.from("loser"),
        outcome: success,
      }),
    );

    expect(heads).toBe(2);
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

      const receipt = await Effect.runPromise(
        makeStore(memory.api).receiptFor("Current prompt"),
      );

      expect(receipt).toMatchObject({
        status: "recorded",
        outcome: {
          history: [{ provider: "unknown", status: "success" }],
          kind: "success",
          provider: "unknown",
        },
      });
      expect(receipt).not.toHaveProperty("outcome.metadata");
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

    const missingReceipt = await Effect.runPromise(store.receiptFor("Prompt"));
    expect(missingReceipt.status).toBe("missing");
    if (missingReceipt.status === "recorded") {
      throw new Error("Expected a missing receipt");
    }
    await Effect.runPromise(
      missingReceipt.record({ kind: "terminal-failure", outcome: failure }),
    );
    const resumed = await Effect.runPromise(store.receiptFor("Prompt"));

    expect(resumed).toEqual({ status: "recorded", outcome: failure });
    expect(memory.puts).toHaveLength(1);
    expect(memory.puts[0]).toMatchObject({
      cacheControl: "no-store",
      contentType: "application/json",
      ifNoneMatch: "*",
      key: "terminal-outcomes/meme-1.json",
      storageClass: "ONEZONE_IA",
    });
  });
});
