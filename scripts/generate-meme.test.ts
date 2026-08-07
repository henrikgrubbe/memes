import {Effect, Exit, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {DoubleModerationError, ModerationBlockedError, ProviderError, RateLimitExhaustedError} from "./errors.js";
import {generateImage} from "./generate-meme.js";
import {MODERATION_FALLBACK, ProvidersService} from "./providers.js";
import type {ProviderFn} from "./providers.js";

// ---- Provider mock helpers ------------------------------------------------

const successFn   = (): ProviderFn => (_) => Effect.succeed({buffer: Buffer.from("hello"), rateLimitHits: 0});
const successRlFn = (hits: number): ProviderFn => (_) => Effect.succeed({buffer: Buffer.from("hello"), rateLimitHits: hits});
const modFn       = (provider: string): ProviderFn => (_) => Effect.fail(new ModerationBlockedError(provider, "blocked"));
const rlFn        = (provider: string): ProviderFn => (_) => Effect.fail(new RateLimitExhaustedError(provider, 10));
const errFn       = (provider: string): ProviderFn => (_) => Effect.fail(new ProviderError(provider, "error"));

// Since only 1 non-fallback candidate (OpenAI), primary is always "OpenAI".
const PRIMARY = "OpenAI";

function providersLayer(primary: ProviderFn, fallback: ProviderFn): Layer.Layer<ProvidersService> {
    return Layer.succeed(ProvidersService, {[PRIMARY]: primary, [MODERATION_FALLBACK]: fallback});
}

const run = <A, E>(effect: Effect.Effect<A, E, ProvidersService>, layer: Layer.Layer<ProvidersService>) =>
    Effect.runPromise(Effect.exit(Effect.provide(effect, layer)));

// ---- generateImage --------------------------------------------------------

describe("generateImage", () => {
    it("returns success with primary provider history", async () => {
        const exit = await run(
            generateImage("make a meme"),
            providersLayer(successFn(), successFn()),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            const {history} = exit.value;
            expect(history).toHaveLength(1);
            expect(history[0]).toEqual({provider: PRIMARY, status: "success"});
        }
    });

    it("records rate-limit hits in history when primary succeeds after rate limits", async () => {
        const exit = await run(
            generateImage("make a meme"),
            providersLayer(successRlFn(2), successFn()),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            const {history} = exit.value;
            expect(history).toHaveLength(3); // 2 rate-limited + 1 success
            expect(history.filter((e) => e.status === "rate-limited")).toHaveLength(2);
            expect(history.at(-1)?.status).toBe("success");
        }
    });

    it("falls back to fallback provider on moderation block", async () => {
        const exit = await run(
            generateImage("make a meme"),
            providersLayer(modFn(PRIMARY), successFn()),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            const {history} = exit.value;
            expect(history[0]).toMatchObject({provider: PRIMARY, status: "failed"});
            expect(history.at(-1)).toMatchObject({provider: MODERATION_FALLBACK, status: "success"});
        }
    });

    it("fails with DoubleModerationError when both providers are blocked", async () => {
        const exit = await run(
            generateImage("make a meme"),
            providersLayer(modFn(PRIMARY), modFn(MODERATION_FALLBACK)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error).toBeInstanceOf(DoubleModerationError);
        }
    });

    it("propagates RateLimitExhaustedError from primary (not a moderation block)", async () => {
        const exit = await run(
            generateImage("make a meme"),
            providersLayer(rlFn(PRIMARY), successFn()),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error).toBeInstanceOf(RateLimitExhaustedError);
        }
    });

    it("propagates ProviderError from primary (not a moderation block)", async () => {
        const exit = await run(
            generateImage("make a meme"),
            providersLayer(errFn(PRIMARY), successFn()),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error).toBeInstanceOf(ProviderError);
        }
    });
});

