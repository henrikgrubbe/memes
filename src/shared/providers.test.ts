import { ConfigProvider, Duration, Effect, Exit, Fiber } from "effect";
import * as TestClock from "effect/TestClock";
import * as TestContext from "effect/TestContext";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  ModerationBlockedError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "./errors.js";
import {
  callWithRetry,
  computeCostCents,
  makeCandidates,
  MAX_RETRIES,
  modelLabel,
  PRIMARY_PROVIDERS,
  ProvidersLayer,
  ProvidersServiceTag,
} from "./providers.js";
import { failureOfType } from "./test-support.js";

const PROVIDER = "test-provider";
const call = (client: OpenAI) =>
  callWithRetry(PROVIDER, client, "m", {}, "prompt");

type ImageResponse = {
  data: Array<{ b64_json?: string; revised_prompt?: string }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
};

function makeClient(responses: Array<() => Promise<ImageResponse>>): OpenAI {
  let i = 0;
  return {
    images: {
      generate: () => responses[Math.min(i++, responses.length - 1)](),
    },
  } as unknown as OpenAI;
}

function makeRequestRecorder() {
  let request: Record<string, unknown> = {};
  const client = {
    images: {
      generate: (params: Record<string, unknown>) => {
        request = params;
        return Promise.resolve({ data: [{ b64_json: "aGk=" }] });
      },
    },
  } as unknown as OpenAI;

  return { client, request: () => request } as const;
}

const ok =
  (b64 = "aGVsbG8=") =>
  (): Promise<ImageResponse> =>
    Promise.resolve({ data: [{ b64_json: b64 }] });
const rl =
  (delayS = 0.001) =>
  (): Promise<ImageResponse> =>
    Promise.reject({
      status: 429,
      message: `try again in ${delayS}s`,
      headers: {},
    });
const rlWithHeader = () => (): Promise<ImageResponse> =>
  Promise.reject({
    status: 429,
    message: "rate limited",
    headers: new Headers({ "retry-after": "0" }),
  });
const mod = () => (): Promise<ImageResponse> =>
  Promise.reject({
    status: 400,
    message: "blocked",
    error: {
      code: "moderation_blocked",
      moderation_details: { moderation_stage: "input" },
    },
  });
const fail =
  (msg = "boom") =>
  (): Promise<ImageResponse> =>
    Promise.reject({ status: 500, message: msg });
const xaiCredits = () => (): Promise<ImageResponse> =>
  Promise.reject({
    status: 403,
    message:
      "Your team abc has either used all available credits or reached its monthly spending limit.",
  });
const insufficientQuota = () => (): Promise<ImageResponse> =>
  Promise.reject({
    status: 429,
    message: "You exceeded your current quota",
    error: { code: "insufficient_quota" },
  });

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.exit(effect));
const runTC = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(
    Effect.exit(effect).pipe(Effect.provide(TestContext.TestContext)),
  );

describe("callWithRetry", () => {
  it("succeeds on first try", async () => {
    const exit = await run(call(makeClient([ok()])));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.buffer.toString("base64")).toBe("aGVsbG8=");
      expect(exit.value.history).toEqual([
        { provider: PROVIDER, status: "success" },
      ]);
    }
  });

  it("captures revised prompt and usage metadata when returned", async () => {
    const client = makeClient([
      () =>
        Promise.resolve({
          data: [
            { b64_json: "aGVsbG8=", revised_prompt: "revised prompt text" },
          ],
          usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
        }),
    ]);
    const exit = await run(call(client));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.metadata).toEqual({
        revisedPrompt: "revised prompt text",
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
      });
    }
  });

  it("estimates cost from usage and the model's pricing", async () => {
    const client = makeClient([
      () =>
        Promise.resolve({
          data: [{ b64_json: "aGVsbG8=" }],
          usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
        }),
    ]);
    // 12 * $5/M + 34 * $30/M = $0.00108 = 0.108¢
    const exit = await run(
      callWithRetry(PROVIDER, client, "m", {}, "prompt", undefined, {
        inputPerMillion: 5,
        outputPerMillion: 30,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.metadata?.costCents).toBeCloseTo(0.108, 6);
    }
  });

  it("leaves cost unset when the model is unpriced", async () => {
    const client = makeClient([
      () =>
        Promise.resolve({
          data: [{ b64_json: "aGVsbG8=" }],
          usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
        }),
    ]);
    const exit = await run(call(client));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.metadata?.costCents).toBeUndefined();
    }
  });

  it("returns ProviderError when response has no image data", async () => {
    const exit = await run(
      call(makeClient([() => Promise.resolve({ data: [] })])),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    failureOfType(exit, ProviderError);
  });

  it("fails immediately with ModerationBlockedError on moderation block", async () => {
    const exit = await run(call(makeClient([mod()])));
    expect(Exit.isFailure(exit)).toBe(true);
    failureOfType(exit, ModerationBlockedError);
  });

  it("fails immediately with ProviderError on generic server error", async () => {
    const exit = await run(call(makeClient([fail("internal error")])));
    expect(Exit.isFailure(exit)).toBe(true);
    failureOfType(exit, ProviderError);
  });

  it("turns a null rejection into ProviderError", async () => {
    const client = makeClient([() => Promise.reject(null)]);
    const exit = await run(call(client));

    expect(Exit.isFailure(exit)).toBe(true);
    failureOfType(exit, ProviderError);
  });

  it("fails with QuotaExhaustedError on a 403 credit/spending-limit error", async () => {
    const exit = await run(call(makeClient([xaiCredits()])));
    expect(Exit.isFailure(exit)).toBe(true);
    failureOfType(exit, QuotaExhaustedError);
  });

  it("fails with QuotaExhaustedError without retrying on 429 insufficient_quota", async () => {
    // Second response would succeed; a quota error must not be retried, so we
    // never reach it.
    const exit = await run(call(makeClient([insufficientQuota(), ok()])));
    expect(Exit.isFailure(exit)).toBe(true);
    failureOfType(exit, QuotaExhaustedError);
  });

  it("retries after rate limit and succeeds", async () => {
    const client = makeClient([rl(), ok()]);
    const test = Effect.gen(function* () {
      const fiber = yield* Effect.fork(call(client));
      yield* TestClock.adjust(Duration.seconds(2));
      return yield* Fiber.join(fiber);
    });

    const exit = await runTC(test);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.history).toEqual([
        { provider: PROVIDER, status: "rate-limited" },
        { provider: PROVIDER, status: "success" },
      ]);
    }
  });

  it("uses Retry-After headers when the response message has no delay", async () => {
    const client = makeClient([rlWithHeader(), ok()]);
    const test = Effect.gen(function* () {
      const fiber = yield* Effect.fork(call(client));
      yield* TestClock.adjust(Duration.seconds(2));
      return yield* Fiber.join(fiber);
    });

    const exit = await runTC(test);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.history).toEqual([
        { provider: PROVIDER, status: "rate-limited" },
        { provider: PROVIDER, status: "success" },
      ]);
    }
  });

  it(`fails with RateLimitError after ${MAX_RETRIES} rate-limit retries`, async () => {
    const responses = Array.from({ length: MAX_RETRIES + 1 }, rl);
    const client = makeClient(responses);
    const test = Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.exit(call(client)));
      yield* TestClock.adjust(Duration.seconds(MAX_RETRIES * 2));
      return yield* Fiber.join(fiber);
    });
    const exit = await runTC(test);
    expect(Exit.isSuccess(exit)).toBe(true); // outer fiber succeeds
    if (Exit.isSuccess(exit)) {
      const inner = exit.value;
      expect(Exit.isFailure(inner)).toBe(true);
      const error = failureOfType(inner, RateLimitError);
      expect(error.attempts).toBe(MAX_RETRIES);
    }
  });

  it("passes extra params through to the API", async () => {
    const recorder = makeRequestRecorder();
    await run(
      callWithRetry(
        PROVIDER,
        recorder.client,
        "dall-e-3",
        { size: "1024x1024", quality: "hd" },
        "cat",
      ),
    );
    expect(recorder.request()["size"]).toBe("1024x1024");
    expect(recorder.request()["quality"]).toBe("hd");
    expect(recorder.request()["model"]).toBe("dall-e-3");
    expect(recorder.request()["prompt"]).toBe("cat");
  });

  it("passes numeric params (e.g. output_compression) through to the API", async () => {
    const recorder = makeRequestRecorder();
    await run(
      callWithRetry(
        PROVIDER,
        recorder.client,
        "gpt-image-2",
        { output_compression: 80 },
        "cat",
      ),
    );
    expect(recorder.request()["output_compression"]).toBe(80);
  });

  it("forwards the end-user id as `user` when provided", async () => {
    const recorder = makeRequestRecorder();
    await run(
      callWithRetry(
        PROVIDER,
        recorder.client,
        "gpt-image-2",
        {},
        "cat",
        "U017Z2VDNJJ",
      ),
    );
    expect(recorder.request()["user"]).toBe("U017Z2VDNJJ");
  });

  it("omits `user` entirely when no end-user id is provided", async () => {
    const recorder = makeRequestRecorder();
    await run(
      callWithRetry(PROVIDER, recorder.client, "gpt-image-2", {}, "cat"),
    );
    expect("user" in recorder.request()).toBe(false);
  });
});

describe("model candidates", () => {
  it("defaults a candidate label to '<provider> (<model>)'", () => {
    expect(
      modelLabel(
        { name: "OpenAI", envKey: "K", models: [] },
        { model: "gpt-image-2" },
      ),
    ).toBe("OpenAI (gpt-image-2)");
  });

  it("honours an explicit label override", () => {
    expect(
      modelLabel(
        { name: "OpenAI", envKey: "K", models: [] },
        { model: "gpt-image-2", label: "Fast" },
      ),
    ).toBe("Fast");
  });

  it("expands each model into its own uniquely-labelled candidate", () => {
    const candidates = makeCandidates(
      {
        name: "OpenAI",
        envKey: "OPENAI_API_KEY",
        models: [
          { model: "gpt-image-2", params: { quality: "low" } },
          {
            model: "gpt-image-2",
            params: { quality: "high" },
            label: "OpenAI HQ",
          },
        ],
      },
      "sk-test",
    );
    expect(candidates.map(([label]) => label)).toEqual([
      "OpenAI (gpt-image-2)",
      "OpenAI HQ",
    ]);
    expect(typeof candidates[0][1]).toBe("function");
  });

  it("configures the OpenAI primary with relaxed moderation and JPEG compression", () => {
    const openai = PRIMARY_PROVIDERS.find((p) => p.name === "OpenAI");
    expect(openai).toBeDefined();
    const model = openai!.models.find((m) => m.model === "gpt-image-2");
    expect(model).toBeDefined();
    expect(model!.params?.moderation).toBe("low");
    expect(model!.params?.output_compression).toBe(80);
    expect(model!.params?.output_format).toBe("jpeg");
    expect(model!.pricing).toEqual({
      inputPerMillion: 5,
      outputPerMillion: 30,
    });
  });
});

describe("computeCostCents", () => {
  it("prices a generation from its token usage", () => {
    // 12 * $5/M + 34 * $30/M = $0.00108 = 0.108¢
    expect(
      computeCostCents(
        { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
        { inputPerMillion: 5, outputPerMillion: 30 },
      ),
    ).toBeCloseTo(0.108, 6);
  });
});

describe("ProvidersLayer (disable-by-omission)", () => {
  // Build the layer under a fake set of env vars and report whether it
  // succeeded. The layer constructs clients but makes no network calls.
  const buildWith = (env: Record<string, string>) =>
    Effect.runPromise(
      ProvidersServiceTag.pipe(
        Effect.provide(ProvidersLayer),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map(Object.entries(env))),
        ),
        Effect.exit,
      ),
    );

  it("dies when no primary provider key is set", async () => {
    const exit = await buildWith({});
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("treats a blank key as disabled and dies with no primary configured", async () => {
    const exit = await buildWith({ OPENAI_API_KEY: "   " });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("builds when the primary key is set, with or without the fallback key", async () => {
    expect(
      Exit.isSuccess(await buildWith({ OPENAI_API_KEY: "sk-primary" })),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        await buildWith({
          OPENAI_API_KEY: "sk-primary",
          XAI_API_KEY: "xai-key",
        }),
      ),
    ).toBe(true);
  });
});
