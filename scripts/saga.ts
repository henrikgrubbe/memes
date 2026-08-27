import OpenAI from "openai";
import {Command, CommandExecutor, FileSystem, Path} from "@effect/platform";
import {Config, Context, Effect, Layer, Option, Schedule} from "effect";
import {AppConfigService} from "./config.js";

// ---- Tunables ---------------------------------------------------------------

// Hard cap on the image-generation prompt (matches the provider limit).
export const MAX_PROMPT_CHARS = 4000;
// Target ceiling for a saga's canon so it always leaves room for the prompt.
export const MAX_CANON_CHARS  = 3000;
// Cheap text model used to fold each new meme into a saga's canon.
export const COMPRESSION_MODEL = "gpt-4o-mini";
// Directory (repo-relative) holding one markdown file per saga.
export const CONTEXT_DIR = "context";

const MAX_PUSH_RETRIES = 5;

// ---- Pure helpers -----------------------------------------------------------

/** Repo-relative path for a saga's canon file. */
export const sagaPath = (saga: string): string => `${CONTEXT_DIR}/${saga}.md`;

/** Truncate canon text to the ceiling so it never blows the prompt budget. */
export const capCanon = (text: string): string =>
    text.length > MAX_CANON_CHARS ? text.slice(0, MAX_CANON_CHARS) : text;

/**
 * Assemble the final image prompt. When a saga canon is supplied it is
 * prepended for continuity, but the meme instruction and user prompt are kept
 * whole and the canon is trimmed to whatever budget remains under the cap.
 */
export function buildMemePrompt(memePrompt: string, saga?: {name: string; canon: string} | null): string {
    const base = `Make a meme: ${memePrompt}.`;
    if (saga == null || saga.canon.trim() === "") {
        return base.slice(0, MAX_PROMPT_CHARS);
    }
    const prefix = `Continuing the "${saga.name}" saga. Canon so far:\n`;
    const suffix = `\n\n${base}`;
    const budget = MAX_PROMPT_CHARS - prefix.length - suffix.length;
    if (budget <= 0) { return base.slice(0, MAX_PROMPT_CHARS); }
    const canon = saga.canon.length > budget ? saga.canon.slice(0, budget) : saga.canon;
    return prefix + canon + suffix;
}

interface ChatMessage { role: "system" | "user"; content: string; }

/** Build the chat messages that fold a new meme idea into a saga's canon. */
export function buildCompressionMessages(saga: string, canon: string, prompt: string): ChatMessage[] {
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
    return [{role: "system", content: system}, {role: "user", content: user}];
}

/** Fallback used when the compression model is unavailable: raw append, capped. */
export const appendFallback = (canon: string, prompt: string): string =>
    capCanon(`${canon}${canon.trim() === "" ? "" : "\n"}- ${prompt}`);

// ---- SagaService ------------------------------------------------------------
// Deep interface: callers read a saga's canon or contribute a meme to it;
// compression, file I/O, git commit/push and contention handling live behind
// the seam. Both methods are total - a saga hiccup never breaks meme delivery.

export interface SagaService {
    read(saga: string): Effect.Effect<string | null>;
    contribute(saga: string, prompt: string): Effect.Effect<void>;
}

export class SagaServiceTag extends Context.Tag("SagaService")<SagaServiceTag, SagaService>() {}

/** Build a Layer from a pre-constructed implementation (bypasses git/OpenAI). */
export const makeSagaLayer = (impl: SagaService): Layer.Layer<SagaServiceTag> =>
    Layer.succeed(SagaServiceTag, impl);

/** No-op layer for tests/deployments that don't exercise sagas. */
export const SagaNoOpLayer: Layer.Layer<SagaServiceTag> =
    makeSagaLayer({read: () => Effect.succeed(null), contribute: () => Effect.void});

// ---- Real adapter -----------------------------------------------------------

class SagaGitError { readonly _tag = "SagaGitError" as const; }

export const SagaLayer: Layer.Layer<SagaServiceTag, never, CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path | AppConfigService> =
    Layer.effect(
        SagaServiceTag,
        Effect.gen(function* () {
            const executor = yield* CommandExecutor.CommandExecutor;
            const fs       = yield* FileSystem.FileSystem;
            const pathSvc  = yield* Path.Path;
            const config   = yield* AppConfigService;

            const apiKey = yield* Config.option(Config.string("OPENAI_API_KEY")).pipe(Effect.orDie);
            const client = Option.isSome(apiKey) && apiKey.value.trim() !== ""
                ? new OpenAI({apiKey: apiKey.value})
                : null;

            const absPath = (saga: string) => pathSvc.join(process.cwd(), CONTEXT_DIR, `${saga}.md`);

            const git = (cmd: string): Effect.Effect<string, SagaGitError> =>
                Command.make("sh", "-c", cmd).pipe(
                    Command.string,
                    Effect.mapError(() => new SagaGitError()),
                    Effect.map((s) => s.trim()),
                    Effect.provideService(CommandExecutor.CommandExecutor, executor),
                );

            const readCanon = (saga: string): Effect.Effect<string | null> =>
                fs.readFileString(absPath(saga)).pipe(Effect.orElseSucceed(() => null));

            // Fold the new prompt into the canon via the text model, falling back
            // to a raw capped append when no client is configured or the call fails.
            const compress = (saga: string, canon: string, prompt: string): Effect.Effect<string> => {
                if (client == null) { return Effect.succeed(appendFallback(canon, prompt)); }
                return Effect.tryPromise(() => client.chat.completions.create({
                    model:    COMPRESSION_MODEL,
                    messages: buildCompressionMessages(saga, canon, prompt),
                })).pipe(
                    Effect.map((res) => {
                        const content = res.choices[0]?.message?.content?.trim();
                        return content != null && content !== "" ? capCanon(content) : appendFallback(canon, prompt);
                    }),
                    Effect.catchAll((err) =>
                        Effect.logWarning(`Saga compression failed - appending raw. ${String(err)}`).pipe(
                            Effect.as(appendFallback(canon, prompt)),
                        )),
                );
            };

            // One read-compress-write-commit-push attempt. Each attempt starts
            // from a freshly pulled tree and re-reads the canon, so concurrent
            // writers to the same saga serialize cleanly (last writer folds its
            // prompt into the other's already-committed canon). On push rejection
            // the local commit is dropped so the next attempt re-derives.
            const attempt = (saga: string, prompt: string): Effect.Effect<void, SagaGitError> =>
                Effect.gen(function* () {
                    yield* git(`git config user.name "github-actions[bot]"`);
                    yield* git(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
                    yield* git(`git pull --rebase origin main`);

                    const canon    = (yield* readCanon(saga)) ?? "";
                    const newCanon = yield* compress(saga, canon, prompt);

                    yield* fs.makeDirectory(pathSvc.join(process.cwd(), CONTEXT_DIR), {recursive: true}).pipe(Effect.ignore);
                    yield* fs.writeFileString(absPath(saga), `${newCanon}\n`).pipe(Effect.mapError(() => new SagaGitError()));

                    yield* git(`git add "${sagaPath(saga)}"`);
                    yield* git(`git commit -m "Update saga ${saga} for issue #${config.issueNumber}"`);
                    yield* git(`git push origin HEAD`).pipe(
                        Effect.tapError(() => git(`git reset --hard HEAD~1`).pipe(Effect.ignore)),
                    );
                });

            return {
                read: (saga) => readCanon(saga),
                contribute: (saga, prompt) =>
                    Effect.retry(attempt(saga, prompt), Schedule.recurs(MAX_PUSH_RETRIES - 1)).pipe(
                        Effect.tap(() => Effect.log(`Saga "${saga}" updated.`)),
                        Effect.catchAll(() => Effect.logWarning(`Saga "${saga}" update failed - meme delivery unaffected.`)),
                    ),
            } satisfies SagaService;
        }),
    );
