import {Effect, Exit, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {DoubleModerationError, ModerationBlockedError, ProviderError, RateLimitError} from "./errors.js";
import {generateImage} from "./generate-meme.js";
import {MODERATION_FALLBACK, makeProvidersLayer, ProvidersServiceTag} from "./providers.js";
import type {ProviderFn} from "./providers.js";

// ---- Provider mock helpers ------------------------------------------------

const successFn   = (provider = PRIMARY): ProviderFn => (_) => Effect.succeed({buffer: Buffer.from("hello"), history: [{provider, status: "success"}]});
const successRlFn = (provider: string, hits: number): ProviderFn => (_) => Effect.succeed({buffer: Buffer.from("hello"), history: [
    ...Array.from({length: hits}, (): {provider: string; status: "rate-limited"} => ({provider, status: "rate-limited"})),
    {provider, status: "success"},
]});
const modFn       = (provider: string): ProviderFn => (_) => Effect.fail(new ModerationBlockedError({provider, detail: "blocked"}));
const rlFn        = (provider: string): ProviderFn => (_) => Effect.fail(new RateLimitError({provider, attempts: 10}));
const errFn       = (provider: string): ProviderFn => (_) => Effect.fail(new ProviderError({provider, detail: "error"}));

// Since only 1 non-fallback candidate (OpenAI), primary is always "OpenAI".
const PRIMARY = "OpenAI";

const run = <A, E>(effect: Effect.Effect<A, E, ProvidersServiceTag>, layer: Layer.Layer<ProvidersServiceTag>) =>
    Effect.runPromise(Effect.exit(Effect.provide(effect, layer)));

// ---- generateImage --------------------------------------------------------

describe("generateImage", () => {
    it("returns success with primary provider history", async () => {
        const exit = await run(
            generateImage("make a meme"),
            makeProvidersLayer({[PRIMARY]: successFn(), [MODERATION_FALLBACK]: successFn()}),
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
            makeProvidersLayer({[PRIMARY]: successRlFn(PRIMARY, 2), [MODERATION_FALLBACK]: successFn()}),
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
            makeProvidersLayer({[PRIMARY]: modFn(PRIMARY), [MODERATION_FALLBACK]: successFn(MODERATION_FALLBACK)}),
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
            makeProvidersLayer({[PRIMARY]: modFn(PRIMARY), [MODERATION_FALLBACK]: modFn(MODERATION_FALLBACK)}),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error).toBeInstanceOf(DoubleModerationError);
        }
    });

    it("propagates RateLimitError from primary (not a moderation block)", async () => {
        const exit = await run(
            generateImage("make a meme"),
            makeProvidersLayer({[PRIMARY]: rlFn(PRIMARY), [MODERATION_FALLBACK]: successFn()}),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error).toBeInstanceOf(RateLimitError);
        }
    });

    it("propagates ProviderError from primary (not a moderation block)", async () => {
        const exit = await run(
            generateImage("make a meme"),
            makeProvidersLayer({[PRIMARY]: errFn(PRIMARY), [MODERATION_FALLBACK]: successFn()}),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            // @ts-expect-error accessing .error on Cause.Fail
            expect(exit.cause.error).toBeInstanceOf(ProviderError);
        }
    });
});

