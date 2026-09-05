import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeScalewayQueueRequest } from "./worker-transport.js";

const task = {
  deliveryId: "delivery-1",
  issueBody:
    "sender: U1\nmessage: Test\nchannel: C1\nlink: https://example.test",
  issueNumber: "42",
  repo: "owner/repo",
};

const encode = Schema.encodeSync(Schema.parseJson(Schema.Unknown));

describe("Scaleway queue transport", () => {
  it("decodes the documented event.body envelope", async () => {
    const decoded = await Effect.runPromise(
      decodeScalewayQueueRequest(encode({ body: encode(task) })),
    );

    expect(decoded).toEqual(task);
  });

  it("tolerates an object body and a direct JSON task for canary compatibility", async () => {
    const objectBody = await Effect.runPromise(
      decodeScalewayQueueRequest(encode({ body: task })),
    );
    const direct = await Effect.runPromise(
      decodeScalewayQueueRequest(encode(task)),
    );

    expect(objectBody).toEqual(task);
    expect(direct).toEqual(task);
  });

  it("rejects malformed envelopes and invalid task identities", async () => {
    const malformed = await Effect.runPromise(
      decodeScalewayQueueRequest("{").pipe(Effect.exit),
    );
    const invalidIssue = await Effect.runPromise(
      decodeScalewayQueueRequest(
        encode({ body: encode({ ...task, issueNumber: "not-a-number" }) }),
      ).pipe(Effect.exit),
    );

    expect(Exit.isFailure(malformed)).toBe(true);
    expect(Exit.isFailure(invalidIssue)).toBe(true);
  });
});
