import {Command, CommandExecutor, FileSystem, Path} from "@effect/platform";
import {NodeCommandExecutor, NodeFileSystem, NodePath} from "@effect/platform-node";
import {Duration, Effect, Either, Layer, Random, Schedule} from "effect";
import * as Schema from "effect/Schema";
import {DoubleModerationError, ExecError, ProviderError, PushFailedError, RateLimitExhaustedError} from "./errors.js";
import {AppConfigService, AppConfigLayer} from "./config.js";
import {MODERATION_FALLBACK, PROVIDER_CONFIGS, ProvidersService, ProvidersLayer} from "./providers.js";

const MAX_PUSH_RETRIES = 5;
const RANDOM_TWISTS = [
    "Make it extremely dramatic.",
    "Use a medieval art style.",
    "Set it in space.",
    "Make it look like a warning label.",
    "Draw it as a motivational poster.",
    "Make it a Renaissance painting.",
    "Give it an 80s action movie vibe.",
    "Make it look like a government document.",
    "Use pixel art style.",
    "Make it extremely passive-aggressive.",
    "Set it in the 1950s.",
    "Make it look like a children's book illustration.",
];

// ---- Types ----------------------------------------------------------------

interface HistoryEntry {
    provider: string;
    status:   "success" | "rate-limited" | "failed";
    message?: string;
}

const SlackPayload = Schema.Struct({
    status:    Schema.Union(Schema.Literal("success"), Schema.Literal("failure")),
    image_url: Schema.String,
    title:     Schema.String,
    requester: Schema.String,
    error:     Schema.String,
    provider:  Schema.optional(Schema.String),
});
type SlackPayload = Schema.Schema.Type<typeof SlackPayload>;

interface SuccessCommentParams {
    memeId: string; provider: string; history: HistoryEntry[];
    prompt: string; twist: string | null; requester: string; channel: string; slackLink: string;
}

// ---- Helpers --------------------------------------------------------------

// Runs a shell command, returns trimmed stdout.
const exec = (cmd: string): Effect.Effect<string, ExecError, CommandExecutor.CommandExecutor> =>
    Command.make("sh", "-c", cmd).pipe(
        Command.string,
        Effect.mapError((e) => new ExecError(cmd, String(e))),
        Effect.map((s) => s.trim()),
    );

// Writes content to a tmp file, calls use(path), then cleans up.
function withTmpFile<R>(
    ext: string,
    content: string,
    use: (tmpPath: string) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R | FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.acquireUseRelease(
            fs.makeTempFile({prefix: "meme-", suffix: `.${ext}`}).pipe(
                Effect.tap((p) => fs.writeFileString(p, content)),
                Effect.orElseSucceed(() => ""),
            ),
            (tmp) => tmp === "" ? Effect.void : use(tmp),
            (tmp) => tmp === "" ? Effect.void : fs.remove(tmp).pipe(Effect.catchAll(() => Effect.void)),
        );
    });
}

const pickRandomTwist = (): Effect.Effect<string | null> =>
    Effect.gen(function* () {
        if ((yield* Random.next) >= 0.4) { return null; }
        return RANDOM_TWISTS[yield* Random.nextIntBetween(0, RANDOM_TWISTS.length)];
    });

// ---- Pipeline steps -------------------------------------------------------

function waitForJitter(): Effect.Effect<void, never, CommandExecutor.CommandExecutor | AppConfigService> {
    return Effect.gen(function* () {
        const config   = yield* AppConfigService;
        const runsJson = yield* exec(`gh api repos/${config.repo}/actions/runs --jq '.workflow_runs | map(select(.status == "in_progress")) | length'`).pipe(
            Effect.orElseSucceed(() => "1"),
        );
        const concurrentRuns = Math.min(isNaN(parseInt(runsJson, 10)) ? 1 : parseInt(runsJson, 10), 10);
        const jitterMs = concurrentRuns <= 1 ? 0 : Math.floor((yield* Random.next) * concurrentRuns * 13_000);
        if (jitterMs > 0) {
            yield* Effect.log(`${concurrentRuns} concurrent runs - waiting ${(jitterMs / 1000).toFixed(1)}s before first attempt...`);
            yield* Effect.sleep(Duration.millis(jitterMs));
        }
    });
}

export function generateImage(prompt: string): Effect.Effect<{
    buffer: Buffer;
    history: HistoryEntry[];
}, DoubleModerationError | ProviderError | RateLimitExhaustedError, ProvidersService> {
    return Effect.gen(function* () {
        const providers  = yield* ProvidersService;
        const candidates = PROVIDER_CONFIGS.map((c) => c.name).filter((n) => n !== MODERATION_FALLBACK);
        const primary    = candidates[yield* Random.nextIntBetween(0, candidates.length)];
        yield* Effect.log(`Randomly selected ${primary} as primary provider...`);

        const primaryResult = yield* providers[primary](prompt).pipe(Effect.either);
        if (Either.isRight(primaryResult)) {
            const {buffer, rateLimitHits} = primaryResult.right;
            return {
                buffer,
                history: [
                    ...Array.from({length: rateLimitHits}, (): HistoryEntry => ({provider: primary, status: "rate-limited"})),
                    {provider: primary, status: "success" as const},
                ],
            };
        }

        const primaryErr = primaryResult.left;
        if (primaryErr._tag !== "ModerationBlockedError") { return yield* Effect.fail(primaryErr); }

        yield* Effect.log(`Moderation block - falling back to ${MODERATION_FALLBACK}...`);
        const primaryEntry: HistoryEntry = {provider: primary, status: "failed", message: primaryErr.message};

        const fallbackResult = yield* providers[MODERATION_FALLBACK](prompt).pipe(Effect.either);
        if (Either.isRight(fallbackResult)) {
            const {buffer, rateLimitHits} = fallbackResult.right;
            return {
                buffer,
                history: [
                    primaryEntry,
                    ...Array.from({length: rateLimitHits}, (): HistoryEntry => ({provider: MODERATION_FALLBACK, status: "rate-limited"})),
                    {provider: MODERATION_FALLBACK, status: "success" as const},
                ],
            };
        }

        return yield* Effect.fail(new DoubleModerationError(MODERATION_FALLBACK));
    });
}

// Internal: single failed push attempt — used only within commitAndPush retry loop.
class PushAttemptError { readonly _tag = "PushAttemptError" as const; }

function commitAndPush(memeId: string): Effect.Effect<void, PushFailedError, CommandExecutor.CommandExecutor | AppConfigService> {
    return Effect.gen(function* () {
        const config = yield* AppConfigService;
        const run    = (cmd: string) => exec(cmd).pipe(Effect.mapError(() => new PushFailedError(0)));

        yield* run(`git config user.name "github-actions[bot]"`);
        yield* run(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
        yield* run(`git add "memes/${memeId}.jpg"`);
        yield* run(`git commit -m "Add meme for issue #${config.issueNumber} (${memeId})"`);
        yield* Effect.log(`Committed memes/${memeId}.jpg`);

        const pushAttempt = exec(`git pull --rebase origin main`).pipe(
            Effect.flatMap(() => exec(`git push origin HEAD`)),
            Effect.mapError(() => new PushAttemptError()),
        );

        yield* Effect.retry(
            pushAttempt.pipe(Effect.tapError(() => Effect.log("Push failed - retrying..."))),
            Schedule.recurs(MAX_PUSH_RETRIES - 1),
        ).pipe(
            Effect.tap(() => Effect.log(`Pushed memes/${memeId}.jpg`)),
            Effect.mapError(() => new PushFailedError(MAX_PUSH_RETRIES)),
        );
    });
}

const postComment = (body: string): Effect.Effect<void, never, CommandExecutor.CommandExecutor | AppConfigService | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const config = yield* AppConfigService;
        yield* withTmpFile("txt", body, (tmp) =>
            exec(`gh issue comment ${config.issueNumber} --repo ${config.repo} --body-file ${tmp}`).pipe(Effect.catchAll(() => Effect.void)),
        );
    });

const postSlack = (data: SlackPayload): Effect.Effect<void, never, CommandExecutor.CommandExecutor | AppConfigService | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const config = yield* AppConfigService;
        const json   = yield* Schema.encode(Schema.parseJson(SlackPayload))(data).pipe(Effect.orDie);
        yield* withTmpFile("json", json, (tmp) =>
            exec(`curl -s -X POST -H 'Content-Type: application/json' -d @${tmp} '${config.slackWebhookUrl}'`).pipe(Effect.catchAll(() => Effect.void)),
        );
    });

function notifySuccess({memeId, history, prompt, twist}: {
    memeId: string; history: HistoryEntry[]; prompt: string; twist: string | null;
}): Effect.Effect<void, never, CommandExecutor.CommandExecutor | AppConfigService | FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const config   = yield* AppConfigService;
        const provider = history.find((e) => e.status === "success")?.provider ?? "unknown";
        const params   = {memeId, provider, history, prompt, twist, requester: config.requester, channel: config.channel, slackLink: config.slackLink};
        yield* postComment(buildSuccessComment(params));
        yield* exec(`gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed`).pipe(Effect.catchAll(() => Effect.void));
        yield* Effect.log(`Issue #${config.issueNumber} closed.`);
        const imageUrl = `https://raw.githubusercontent.com/${config.repo}/refs/heads/main/memes/${memeId}.jpg`;
        yield* postSlack({status: "success", image_url: imageUrl, title: config.memePrompt, requester: config.requester, error: "", provider});
    });
}

function buildSuccessComment({memeId, provider, history, prompt, twist, requester, channel, slackLink}: SuccessCommentParams): string {
    const providerNote  = ` _(${[provider, twist].filter((x) => x != null).join(" - ")})_`;
    const promptDisplay = prompt.includes("`") ? `\`\`${prompt}\`\`` : `\`${prompt}\``;
    return [
        `🎉 Meme generated and committed to [memes/${memeId}.jpg](../blob/main/memes/${memeId}.jpg)${providerNote}`,
        ``,
        `**Requested by:** ${requester} in ${channel} - [View in Slack](${slackLink})`,
        `**Prompt:** ${promptDisplay}`,
        ``,
        `**Provider attempts:**`,
        ...history.map(({provider, status, message}) => {
            switch (status) {
                case "success":      return `- ${provider} ✅`;
                case "rate-limited": return `- ${provider} ⏳ rate limited`;
                default:             return `- ${provider} ❌ (${message})`;
            }
        }),
    ].join("\n");
}

// ---- Program --------------------------------------------------------------

const program = Effect.gen(function* () {
    const config   = yield* AppConfigService;
    const fsys     = yield* FileSystem.FileSystem;
    const pathSvc  = yield* Path.Path;
    const memeId   = crypto.randomUUID();
    const memesDir = pathSvc.join(process.cwd(), "memes");
    const outFile  = pathSvc.join(memesDir, `${memeId}.jpg`);
    const twist    = yield* pickRandomTwist();

    const fullPrompt = `Make a meme: ${config.memePrompt}.${twist != null ? ` ${twist}` : ""}`;
    if (fullPrompt.length > 4000) {
        yield* Effect.logWarning(`Prompt truncated from ${fullPrompt.length} to 4000 characters.`);
    }
    const prompt = fullPrompt.slice(0, 4000);
    yield* fsys.makeDirectory(memesDir, {recursive: true});

    yield* Effect.log(`Starting generation for issue #${config.issueNumber}: "${config.memePrompt}"`);
    yield* waitForJitter();
    const {buffer, history} = yield* generateImage(prompt);
    yield* fsys.writeFile(outFile, buffer);
    yield* Effect.log(`Image saved: ${outFile}`);
    yield* commitAndPush(memeId);
    yield* notifySuccess({memeId, history, prompt, twist});
    yield* Effect.log("Done.");
}).pipe(
    Effect.catchAll((e) => Effect.gen(function* () {
        const config = yield* AppConfigService;
        const msg    = e != null && typeof e === "object" && "message" in e ? String((e as {message: unknown}).message) : String(e);
        const tag    = e != null && typeof e === "object" && "_tag" in e ? (e as {_tag: string})._tag : "";
        yield* Effect.logError(`Fatal: ${msg}`);
        yield* postComment(`❌ Meme generation failed.\n\n\`\`\`\n${msg}\n\`\`\``);
        yield* postSlack({status: "failure", image_url: "", title: config.memePrompt, requester: config.requester, error: msg});
        if (tag === "DoubleModerationError") {
            yield* exec(`gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed -f state_reason=not_planned`).pipe(Effect.catchAll(() => Effect.void));
        }
        return yield* Effect.die("failure-handled");
    })),
);

const AppLayer = Layer.mergeAll(
    AppConfigLayer,
    NodePath.layer,
    NodeFileSystem.layer,
    ProvidersLayer,
    NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
);

import {fileURLToPath} from "url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    Effect.runPromise(
        Effect.provide(program, AppLayer).pipe(
            Effect.tapError((e) => Effect.logError(e.message)),
        ),
    ).catch(() => process.exit(1));
}
