import {Duration, Effect, Exit, Fiber, Layer} from "effect";
import * as TestClock from "effect/TestClock";
import * as TestContext from "effect/TestContext";
import type OpenAI from "openai";
import {describe, expect, it} from "vitest";
import {ModerationBlockedError, ProviderError, RateLimitError} from "./errors.js";
import {callWithRetry, MAX_RETRIES} from "./providers.js";

const PROVIDER = "test-provider";
const call = (client: OpenAI) => callWithRetry(PROVIDER, client, "m", {}, "prompt");

// ---- Mock OpenAI client factory -------------------------------------------

type ImageResponse = {data: Array<{b64_json?: string}>};

function makeClient(responses: Array<() => Promise<ImageResponse>>): OpenAI {
    let i = 0;
    return {
        images: {
            generate: () => responses[Math.min(i++, responses.length - 1)](),
        },
    } as unknown as OpenAI;
}

const ok    = (b64 = "aGVsbG8=") => (): Promise<ImageResponse> => Promise.resolve({data: [{b64_json: b64}]});
const rl    = (delayS = 0.001)   => (): Promise<ImageResponse> => Promise.reject({status: 429, message: `try again in ${delayS}s`, headers: {}});
const mod   = ()                  => (): Promise<ImageResponse> => Promise.reject({status: 400, message: "blocked", error: {code: "moderation_blocked", moderation_details: {moderation_stage: "input"}}});
const fail  = (msg = "boom")     => (): Promise<ImageResponse> => Promise.reject({status: 500, message: msg});

const run   = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect));
const runTC = <A, E>(effect: Effect.Effect<A, E, never>) =>
    Effect.runPromise(Effect.exit(effect).pipe(Effect.provide(TestContext.TestContext)));

// ---- Tests ----------------------------------------------------------------

describe("callWithRetry", () => {
    it("succeeds on first try", async () => {
        const exit = await run(call(makeClient([ok()])));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            expect(exit.value.buffer.toString("base64")).toBe("aGVsbG8=");
            expect(exit.value.history).toEqual([{provider: PROVIDER, status: "success"}]);
        }
    });

    it("returns ProviderError when response has no image data", async () => {
        const exit = await run(call(makeClient([() => Promise.resolve({data: []})])));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            expect(exit.cause._tag).toBe("Fail");
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error._tag).toBe("ProviderError");
        }
    });

    it("fails immediately with ModerationBlockedError on moderation block", async () => {
        const exit = await run(call(makeClient([mod()])));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error).toBeInstanceOf(ModerationBlockedError);
        }
    });

    it("fails immediately with ProviderError on generic server error", async () => {
        const exit = await run(call(makeClient([fail("internal error")])));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error).toBeInstanceOf(ProviderError);
        }
    });

    it("retries after rate limit and succeeds", async () => {
        const client = makeClient([rl(), ok()]);
        const test   = Effect.gen(function* () {
            const fiber = yield* Effect.fork(call(client));
            yield* TestClock.adjust(Duration.seconds(2));
            return yield* Fiber.join(fiber);
        });
        const exit = await runTC(test);
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            expect(exit.value.history).toEqual([
                {provider: PROVIDER, status: "rate-limited"},
                {provider: PROVIDER, status: "success"},
            ]);
        }
    });

    it(`fails with RateLimitError after ${MAX_RETRIES} rate-limit retries`, async () => {
        const responses = Array.from({length: MAX_RETRIES + 1}, rl);
        const client    = makeClient(responses);
        const test      = Effect.gen(function* () {
            const fiber = yield* Effect.fork(
                Effect.exit(call(client)),
            );
            yield* TestClock.adjust(Duration.seconds(MAX_RETRIES * 2));
            return yield* Fiber.join(fiber);
        });
        const exit = await runTC(test);
        expect(Exit.isSuccess(exit)).toBe(true); // outer fiber succeeds
        if (Exit.isSuccess(exit)) {
            const inner = exit.value;
            expect(Exit.isFailure(inner)).toBe(true);
            if (Exit.isFailure(inner)) {
                // @ts-expect-error accessing .error on Cause.Fail
                expect(inner.cause.error).toBeInstanceOf(RateLimitError);
                // @ts-expect-error accessing .error on Cause.Fail
                expect(inner.cause.error.attempts).toBe(MAX_RETRIES);
            }
        }
    });

    it("passes extra params through to the API", async () => {
        let capturedParams: Record<string, unknown> = {};
        const client = {
            images: {
                generate: (p: Record<string, unknown>) => {
                    capturedParams = p;
                    return Promise.resolve({data: [{b64_json: "aGk="}]});
                },
            },
        } as unknown as OpenAI;
        await run(callWithRetry(PROVIDER, client, "dall-e-3", {size: "1024x1024", quality: "hd"}, "cat"));
        expect(capturedParams["size"]).toBe("1024x1024");
        expect(capturedParams["quality"]).toBe("hd");
        expect(capturedParams["model"]).toBe("dall-e-3");
        expect(capturedParams["prompt"]).toBe("cat");
    });
});
