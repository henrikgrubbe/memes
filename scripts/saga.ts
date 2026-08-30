import OpenAI from "openai";
import { FileSystem, Path } from "@effect/platform";
import { Config, Context, Data, Effect, Layer, Option } from "effect";
import { AppConfigService } from "./config.js";
import { GitServiceTag } from "./git.js";

// Hard cap on the image-generation prompt (matches the provider limit).
export const MAX_PROMPT_CHARS = 4000;
// Target ceiling for a saga's canon so it always leaves room for the prompt.
export const MAX_CANON_CHARS = 3000;
// Cheap text model used to fold each new meme into a saga's canon.
export const COMPRESSION_MODEL = "gpt-4o-mini";
// Upper bound on compression output, so a runaway response can't balloon the
// canon. ~4 chars/token, with headroom above MAX_CANON_CHARS.
export const MAX_CANON_TOKENS = 900;
// Directory (repo-relative) holding one markdown file per saga.
export const CONTEXT_DIR = "context";

/** Repo-relative path for a saga's canon file. */
export const sagaPath = (saga: string): string => `${CONTEXT_DIR}/${saga}.md`;

/**
 * Clamp canon text to the ceiling. This is only a last-resort safety net (the
 * model is asked to stay under budget and gets a shorten retry first). When it
 * must cut, it prefers the last paragraph/line/sentence boundary within budget
 * so the canon isn't left dangling mid-word.
 */
export function capCanon(text: string): string {
  if (text.length <= MAX_CANON_CHARS) {
    return text;
  }

  const slice = text.slice(0, MAX_CANON_CHARS);
  const boundary = Math.max(
    slice.lastIndexOf("\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  const end = boundary > MAX_CANON_CHARS * 0.6 ? boundary : slice.length;
  return slice.slice(0, end).trimEnd();
}

/**
 * Assemble the final image prompt. When a saga canon is supplied it is
 * prepended for continuity, but the meme instruction and user prompt are kept
 * whole and the canon is trimmed to whatever budget remains under the cap.
 */
export function buildMemePrompt(
  memePrompt: string,
  saga?: { readonly name: string; readonly canon: string } | null,
): string {
  const base = `Make a meme: ${memePrompt}.`;
  if (saga == null || saga.canon.trim() === "") {
    return base.slice(0, MAX_PROMPT_CHARS);
  }
  const prefix = `Continuing the "${saga.name}" saga. Canon so far:\n`;
  const suffix = `\n\n${base}`;
  const budget = MAX_PROMPT_CHARS - prefix.length - suffix.length;

  if (budget <= 0) {
    return base.slice(0, MAX_PROMPT_CHARS);
  }

  const canon = saga.canon.slice(0, budget);
  return prefix + canon + suffix;
}

interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/** Build the chat messages that fold a new meme idea into a saga's canon. */
export function buildCompressionMessages(
  saga: string,
  canon: string,
  prompt: string,
): ReadonlyArray<ChatMessage> {
  const system = [
    `You maintain a running "canon": a compact, evolving summary of a series of`,
    `user-submitted meme ideas that all belong to the saga "${saga}".`,
    `Given the current canon and ONE new meme idea, produce an UPDATED canon that:`,
    `- integrates the new idea,`,
    `- preserves recurring characters, running jokes, locations and key story beats,`,
    `- is written as concise descriptive notes, not prose,`,
    `- stays under ${MAX_CANON_CHARS} characters,`,
    `- keeps the same language as the ideas.`,
    `Output ONLY the canon text, with no preamble or commentary.`,
  ].join("\n");
  const user = [
    `Current canon:`,
    canon.trim() === "" ? "(empty - this is the first entry)" : canon,
    ``,
    `New meme idea:`,
    prompt,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Ask the model to shrink an over-budget canon without losing key elements. */
export function buildShortenMessages(
  saga: string,
  overlong: string,
): ReadonlyArray<ChatMessage> {
  const system = [
    `You are editing the canon for the saga "${saga}".`,
    `Rewrite it to be SHORTER without losing recurring characters, running`,
    `jokes, locations or key story beats. It MUST be under ${MAX_CANON_CHARS}`,
    `characters. Keep the same language. Output ONLY the canon text.`,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: `Canon to shorten:\n${overlong}` },
  ];
}

/** Fallback used when the compression model is unavailable: raw append, capped. */
export const appendFallback = (canon: string, prompt: string): string =>
  capCanon(`${canon}${canon.trim() === "" ? "" : "\n"}- ${prompt}`);

/**
 * Best-effort human-readable description of an OpenAI/transport error. The SDK
 * throws rich `APIError`s (status/code/message); without this they collapse to
 * an opaque "UnknownException" once wrapped by Effect.tryPromise.
 */
export function describeModelError(error: unknown): string {
  const value = error as {
    readonly status?: number;
    readonly code?: string;
    readonly type?: string;
    readonly message?: string;
    readonly error?: {
      readonly message?: string;
      readonly code?: string;
      readonly type?: string;
    };
    readonly cause?: { readonly message?: string };
  };
  const status = value?.status == null ? "" : `HTTP ${value.status} `;
  const code =
    value?.code ?? value?.error?.code ?? value?.type ?? value?.error?.type;
  const message =
    value?.error?.message ??
    value?.message ??
    value?.cause?.message ??
    String(error);

  return `${status}${code == null ? "" : `[${code}] `}${message}`.trim();
}

/**
 * Fold a new meme idea into the canon using an injected model call. Total by
 * construction: if the first response overshoots the budget it gets one
 * "shorten" retry, then the result is boundary-clamped; any model failure falls
 * back to a raw capped append so a write is never lost. Pure w.r.t. transport,
 * so it is unit-tested without the network.
 */
export function foldCanon<E>(
  callModel: (messages: ReadonlyArray<ChatMessage>) => Effect.Effect<string, E>,
  saga: string,
  canon: string,
  prompt: string,
): Effect.Effect<string> {
  return callModel(buildCompressionMessages(saga, canon, prompt)).pipe(
    Effect.flatMap((first) =>
      first.length <= MAX_CANON_CHARS
        ? Effect.succeed(first)
        : callModel(buildShortenMessages(saga, first)).pipe(
            Effect.orElseSucceed(() => first),
          ),
    ),
    Effect.map(capCanon),
    Effect.catchAll((error) =>
      Effect.logWarning(
        `Saga compression failed - appending raw. ${String(error)}`,
      ).pipe(Effect.as(appendFallback(canon, prompt))),
    ),
  );
}

// Deep interface: callers read a saga's canon or contribute a meme to it;
// compression, file I/O, git commit/push and contention handling live behind
// the seam. Both methods are total - a saga hiccup never breaks meme delivery.

export interface SagaService {
  readonly read: (saga: string) => Effect.Effect<string | null>;
  readonly contribute: (saga: string, prompt: string) => Effect.Effect<void>;
}

export class SagaServiceTag extends Context.Tag("SagaService")<
  SagaServiceTag,
  SagaService
>() {}

/** Build a Layer from a pre-constructed implementation (bypasses git/OpenAI). */
export const makeSagaLayer = (impl: SagaService): Layer.Layer<SagaServiceTag> =>
  Layer.succeed(SagaServiceTag, impl);

/** No-op layer for tests/deployments that don't exercise sagas. */
export const SagaNoOpLayer: Layer.Layer<SagaServiceTag> = makeSagaLayer({
  read: () => Effect.succeed(null),
  contribute: () => Effect.void,
});

class CompressionError extends Data.TaggedError("CompressionError")<{
  readonly detail: string;
}> {
  public get message(): string {
    return this.detail;
  }
}

type ModelCall = (
  messages: ReadonlyArray<ChatMessage>,
) => Effect.Effect<string, CompressionError>;

const toOpenAiMessage = (
  message: ChatMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam =>
  message.role === "system"
    ? { role: "system", content: message.content }
    : { role: "user", content: message.content };

const makeModelCall =
  (client: OpenAI): ModelCall =>
  (messages) =>
    Effect.tryPromise({
      try: () =>
        client.chat.completions.create({
          model: COMPRESSION_MODEL,
          messages: messages.map(toOpenAiMessage),
          max_completion_tokens: MAX_CANON_TOKENS,
        }),
      catch: (error) =>
        new CompressionError({ detail: describeModelError(error) }),
    }).pipe(
      Effect.flatMap((response) => {
        const content = response.choices[0]?.message?.content?.trim();
        return content == null || content === ""
          ? Effect.fail(
              new CompressionError({
                detail: "empty compression response",
              }),
            )
          : Effect.succeed(content);
      }),
    );

export const SagaLayer: Layer.Layer<
  SagaServiceTag,
  never,
  FileSystem.FileSystem | Path.Path | AppConfigService | GitServiceTag
> = Layer.effect(
  SagaServiceTag,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* AppConfigService;
    const git = yield* GitServiceTag;
    const apiKey = yield* Config.option(Config.string("OPENAI_API_KEY")).pipe(
      Effect.orDie,
    );
    const callModel = Option.match(apiKey, {
      onNone: (): ModelCall | null => null,
      onSome: (value): ModelCall | null =>
        value.trim() === ""
          ? null
          : makeModelCall(new OpenAI({ apiKey: value })),
    });

    const absPath = (saga: string) =>
      path.join(process.cwd(), CONTEXT_DIR, `${saga}.md`);

    const readCanon = (saga: string): Effect.Effect<string | null> =>
      fs.readFileString(absPath(saga)).pipe(Effect.orElseSucceed(() => null));

    const compress = (
      saga: string,
      canon: string,
      prompt: string,
    ): Effect.Effect<string> =>
      callModel == null
        ? Effect.succeed(appendFallback(canon, prompt))
        : foldCanon(callModel, saga, canon, prompt);

    const stage = (
      saga: string,
      prompt: string,
    ): Effect.Effect<ReadonlyArray<string>> =>
      Effect.gen(function* () {
        const canon = (yield* readCanon(saga)) ?? "";
        const newCanon = yield* compress(saga, canon, prompt);
        yield* fs
          .makeDirectory(path.join(process.cwd(), CONTEXT_DIR), {
            recursive: true,
          })
          .pipe(Effect.ignore);
        yield* fs
          .writeFileString(absPath(saga), `${newCanon}\n`)
          .pipe(Effect.orDie);

        return [sagaPath(saga)];
      });

    return {
      read: readCanon,
      contribute: (saga, prompt) =>
        git
          .commitToMain({
            message: `Update saga ${saga} for issue #${config.issueNumber}`,
            stage: stage(saga, prompt),
          })
          .pipe(
            Effect.tap(() => Effect.log(`Saga "${saga}" updated.`)),
            Effect.catchAll(() =>
              Effect.logWarning(
                `Saga "${saga}" update failed - meme delivery unaffected.`,
              ),
            ),
          ),
    } satisfies SagaService;
  }),
);
