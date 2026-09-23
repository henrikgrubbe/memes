import OpenAI from "openai";
import { Data, Effect } from "effect";

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

export interface SagaContext {
  readonly canon: string;
  readonly name: string;
}

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
 * supplied as background, while the current request remains the primary image
 * instruction. The canon is trimmed to whatever budget remains under the cap.
 */
const promptPrefix = "Background for continuity:\n";

const sagaContextText = (contexts: ReadonlyArray<SagaContext>): string => {
  const nonEmpty = contexts.filter(({ canon }) => canon.trim() !== "");
  if (nonEmpty.length === 0) {
    return "";
  }
  if (nonEmpty.length === 1) {
    return nonEmpty[0].canon;
  }
  return nonEmpty.map(({ name, canon }) => `Saga "${name}":\n${canon}`).join("\n\n");
};

export const maxSagaContextChars = (memePrompt: string): number =>
  Math.max(
    0,
    MAX_PROMPT_CHARS -
      promptPrefix.length -
      "\n\nCurrent request - depict this now:\n".length -
      memePrompt.length,
  );

/** Render one or more saga canons as labeled background for an image request. */
export const renderSagaContexts = (contexts: ReadonlyArray<SagaContext>): string =>
  sagaContextText(contexts);

export function buildMemePrompt(
  memePrompt: string,
  saga?: string | SagaContext | ReadonlyArray<SagaContext> | null,
): string {
  const base = memePrompt;
  const context =
    typeof saga === "string"
      ? saga
      : sagaContextText(saga == null ? [] : Array.isArray(saga) ? saga : [saga]);
  if (context === "") {
    return base.slice(0, MAX_PROMPT_CHARS);
  }
  const prefix = promptPrefix;
  const suffix = `\n\nCurrent request - depict this now:\n${base}`;
  const budget = MAX_PROMPT_CHARS - prefix.length - suffix.length;

  if (budget <= 0) {
    return base.slice(0, MAX_PROMPT_CHARS);
  }

  const canon = context.slice(0, budget);
  return prefix + canon + suffix;
}

interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/** Build the chat messages that fold a new contribution into a saga's canon. */
export function buildCompressionMessages(
  saga: string,
  canon: string,
  prompt: string,
): ReadonlyArray<ChatMessage> {
  const system = [
    `You maintain the canon: the story so far for the saga "${saga}".`,
    `Update the existing canon with ONE new contribution.`,
    `The updated canon must:`,
    `- include the important information from the new contribution,`,
    `- preserve recurring characters, running jokes, locations and key story beats,`,
    `- correct, replace, invalidate, resolve or remove existing information when the`,
    `  new contribution requires it, without keeping obsolete versions,`,
    `- remove other information only when it is obsolete or necessary to stay under`,
    `  ${MAX_CANON_CHARS} characters,`,
    `- use the same language as the contribution.`,
    `Format the canon as concise Markdown. Use only useful headings and short bullet`,
    `lists. Do not use tables, deep nesting, emphasis or decorative formatting.`,
    `Preserve the existing structure when practical.`,
    `Output ONLY the canon text, with no preamble or commentary.`,
  ].join("\n");
  const user = [
    `This is the story so far:`,
    canon.trim() === "" ? "(empty - this is the first entry)" : canon,
    ``,
    `New contribution:`,
    prompt,
    ``,
    `Update the story and keep it under ${MAX_CANON_CHARS} characters.`,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Ask the model to shrink an over-budget canon without losing key elements. */
export function buildShortenMessages(saga: string, overlong: string): ReadonlyArray<ChatMessage> {
  const system = [
    `You are editing the canon for the saga "${saga}".`,
    `Rewrite it to be SHORTER without losing recurring characters, running`,
    `jokes, locations or key story beats. It MUST be under ${MAX_CANON_CHARS}`,
    `characters. Keep the same language and concise Markdown format. Use only`,
    `useful headings and short bullet lists. Do not use tables, deep nesting,`,
    `emphasis or decorative formatting. Output ONLY the canon text.`,
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
  const code = value?.code ?? value?.error?.code ?? value?.type ?? value?.error?.type;
  const message = value?.error?.message ?? value?.message ?? value?.cause?.message ?? String(error);

  return `${status}${code == null ? "" : `[${code}] `}${message}`.trim();
}

/**
 * Fold a new contribution into the canon using an injected model call. Total by
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
        : callModel(buildShortenMessages(saga, first)).pipe(Effect.orElseSucceed(() => first)),
    ),
    Effect.map(capCanon),
    Effect.catchAll((error) =>
      Effect.logWarning(`Saga compression failed - appending raw. ${String(error)}`).pipe(
        Effect.as(appendFallback(canon, prompt)),
      ),
    ),
  );
}

class CompressionError extends Data.TaggedError("CompressionError")<{
  readonly detail: string;
}> {
  public get message(): string {
    return this.detail;
  }
}

type ModelCall = (messages: ReadonlyArray<ChatMessage>) => Effect.Effect<string, CompressionError>;

export type SagaContextShortener = (
  contexts: ReadonlyArray<SagaContext>,
  maximumChars: number,
) => Effect.Effect<string>;

const buildCombinedContextShortenMessages = (
  contexts: ReadonlyArray<SagaContext>,
  maximumChars: number,
): ReadonlyArray<ChatMessage> => [
  {
    role: "system",
    content: [
      `You condense background canon from several independent meme sagas.`,
      `Produce one temporary concise Markdown context under ${maximumChars} characters.`,
      `Preserve each saga's recurring characters, running jokes, locations, and`,
      `key story beats. Keep each saga clearly labeled so unrelated facts are not`,
      `merged. Use the same language as the input. Do not use tables, deep nesting,`,
      `emphasis, decorative formatting, preamble, or commentary.`,
      `Output ONLY the temporary context. It will not be saved back to any saga.`,
    ].join("\n"),
  },
  {
    role: "user",
    content: `Saga canons to combine:\n${renderSagaContexts(contexts)}`,
  },
];

export type SagaCompressor = (saga: string, canon: string, prompt: string) => Effect.Effect<string>;

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
      catch: (error) => new CompressionError({ detail: describeModelError(error) }),
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

export const makeSagaCompressor = (apiKey: string | null): SagaCompressor => {
  const callModel =
    apiKey == null || apiKey.trim() === "" ? null : makeModelCall(new OpenAI({ apiKey }));

  return (saga, canon, prompt) =>
    callModel == null
      ? Effect.succeed(appendFallback(canon, prompt))
      : foldCanon(callModel, saga, canon, prompt);
};

/**
 * Build an ephemeral combined context only when several read sagas no longer
 * fit alongside the image instruction. A model outage still leaves a bounded,
 * labeled context and is recorded for operational visibility.
 */
export const makeSagaContextShortener = (apiKey: string | null): SagaContextShortener => {
  const callModel =
    apiKey == null || apiKey.trim() === "" ? null : makeModelCall(new OpenAI({ apiKey }));

  return (contexts, maximumChars) => {
    const fallback = () => Effect.succeed(renderSagaContexts(contexts).slice(0, maximumChars));
    if (callModel == null) {
      return Effect.logWarning(
        "Saga context reduction skipped because no text-model API key is configured",
      ).pipe(Effect.zipRight(fallback()));
    }
    return callModel(buildCombinedContextShortenMessages(contexts, maximumChars)).pipe(
      Effect.map((context) => context.slice(0, maximumChars)),
      Effect.catchAll((error) =>
        Effect.logWarning(
          `Saga context reduction failed - using capped source context. ${error.message}`,
        ).pipe(Effect.zipRight(fallback())),
      ),
    );
  };
};
