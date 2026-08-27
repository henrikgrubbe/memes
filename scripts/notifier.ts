import {Command, CommandExecutor, FileSystem} from "@effect/platform";
import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {AppConfigService} from "./config.js";
import type {GenerationMetadata, HistoryEntry} from "./providers.js";

// ---- Types ------------------------------------------------------------------

const SlackPayload = Schema.Struct({
    status:     Schema.Literal("success", "failure"),
    image_url:  Schema.String,
    title:      Schema.String,
    requester:  Schema.String,
    channel:    Schema.String,
    error:      Schema.String,
    provider:   Schema.optional(Schema.String),
    // Slack webhooks are text-only, so this is a display-ready string (e.g. "0.108¢").
    cost_cents: Schema.optional(Schema.String),
});
type SlackPayload = Schema.Schema.Type<typeof SlackPayload>;

export interface NotifySuccessParams {
    memeId:   string;
    history:  HistoryEntry[];
    prompt:   string;
    metadata?: GenerationMetadata;
}

// ---- NotifierService --------------------------------------------------------
// Deep interface: callers describe what happened; how to post, format, and
// encode all lives behind this seam.

export interface NotifierService {
    notifySuccess(params: NotifySuccessParams): Effect.Effect<void>;
    notifyFailure(message: string, closeNotPlanned?: boolean, history?: ReadonlyArray<HistoryEntry>): Effect.Effect<void>;
}

export class NotifierServiceTag extends Context.Tag("NotifierService")<NotifierServiceTag, NotifierService>() {}

// ---- Real adapter -----------------------------------------------------------

type NotifierDeps = CommandExecutor.CommandExecutor | AppConfigService | FileSystem.FileSystem;

const exec = (cmd: string): Effect.Effect<string, never, CommandExecutor.CommandExecutor> =>
    Command.make("sh", "-c", cmd).pipe(
        Command.string,
        Effect.orDie,
        Effect.map((s) => s.trim()),
    );

const withTmpFile = <A>(ext: string, content: string, use: (path: string) => Effect.Effect<A, never, CommandExecutor.CommandExecutor>): Effect.Effect<A, never, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs  = yield* FileSystem.FileSystem;
        const tmp = yield* fs.makeTempFileScoped({suffix: `.${ext}`}).pipe(Effect.orDie);
        yield* fs.writeFileString(tmp, content).pipe(Effect.orDie);
        return yield* use(tmp);
    }).pipe(Effect.scoped);

const postComment = (body: string): Effect.Effect<void, never, NotifierDeps> =>
    Effect.gen(function* () {
        const config = yield* AppConfigService;
        yield* withTmpFile("txt", body, (tmp) =>
            exec(`gh issue comment ${config.issueNumber} --repo ${config.repo} --body-file ${tmp}`).pipe(Effect.ignore),
        );
    });

const postSlack = (data: SlackPayload): Effect.Effect<void, never, NotifierDeps> =>
    Effect.gen(function* () {
        const config = yield* AppConfigService;
        const json   = yield* Schema.encode(Schema.parseJson(SlackPayload))(data).pipe(Effect.orDie);
        yield* withTmpFile("json", json, (tmp) =>
            exec(`curl -s -X POST -H 'Content-Type: application/json' -d @${tmp} '${config.slackWebhookUrl}'`).pipe(Effect.ignore),
        );
    });

// gpt-image-2 token prices derived from empirical cost/usage data: $5/M input, $30/M output
const INPUT_TOKEN_PRICE_PER_M  = 5;
const OUTPUT_TOKEN_PRICE_PER_M = 30;

/** Estimated generation cost in cents, or null when token usage is unknown. */
export function estimateCostCents(metadata?: GenerationMetadata): number | null {
    const usage = metadata?.usage;
    if (usage == null) { return null; }
    return (usage.inputTokens * INPUT_TOKEN_PRICE_PER_M + usage.outputTokens * OUTPUT_TOKEN_PRICE_PER_M) / 1_000_000 * 100;
}

/** Display-ready cost string (e.g. "0.108¢"), or null when token usage is unknown. */
export function formatCostCents(metadata?: GenerationMetadata): string | null {
    const costCents = estimateCostCents(metadata);
    return costCents == null ? null : `${costCents.toFixed(3)}¢`;
}

/** Render the shared "Provider attempts" bullet list from an attempt history. */
export function renderProviderAttempts(history: ReadonlyArray<HistoryEntry>): string[] {
    return history.map(({provider, status, message}) => {
        switch (status) {
            case "success":      return `- ${provider} ✅`;
            case "rate-limited": return `- ${provider} ⏳ rate limited`;
            default:             return `- ${provider} ❌ (${message})`;
        }
    });
}

export function buildSuccessComment({memeId, provider, history, prompt, requester, channel, slackLink, repo, metadata}: {
    memeId: string; provider: string; history: HistoryEntry[];
    prompt: string; requester: string; channel: string; slackLink: string; repo: string; metadata?: GenerationMetadata;
}): string {
    const providerNote  = ` _(${provider})_`;
    const promptDisplay = prompt.includes("`") ? `\`\`${prompt}\`\`` : `\`${prompt}\``;
    const revisedPrompt = metadata?.revisedPrompt;
    const revisedPromptDisplay = revisedPrompt == null
        ? null
        : (revisedPrompt.includes("`") ? `\`\`${revisedPrompt}\`\`` : `\`${revisedPrompt}\``);
    const usageSummary = metadata?.usage == null
        ? null
        : `${metadata.usage.inputTokens} input, ${metadata.usage.outputTokens} output, ${metadata.usage.totalTokens} total tokens`;
    const costCents = formatCostCents(metadata);
    const blobUrl       = `https://github.com/${repo}/blob/main/memes/${memeId}.jpg`;
    const imageUrl      = `https://raw.githubusercontent.com/${repo}/refs/heads/main/memes/${memeId}.jpg`;
    return [
        `🎉 Meme generated and committed to [memes/${memeId}.jpg](${blobUrl})${providerNote}`,
        ``,
        `![Generated meme](${imageUrl})`,
        ``,
        `**Requested by:** ${requester} in ${channel} - [View in Slack](${slackLink})`,
        `**Prompt:** ${promptDisplay}`,
        ...(revisedPromptDisplay == null ? [] : [`**Revised prompt:** ${revisedPromptDisplay}`]),
        ...(usageSummary == null ? [] : [`**Usage:** ${usageSummary}`]),
        ...(costCents == null ? [] : [`**Estimated cost:** ${costCents}`]),
        ``,
        `**Provider attempts:**`,
        ...renderProviderAttempts(history),
    ].join("\n");
}

/** Build the issue comment for a failed generation, including any attempt history. */
export function buildFailureComment(message: string, history?: ReadonlyArray<HistoryEntry>): string {
    const attempts = history != null && history.length > 0
        ? [``, `**Provider attempts:**`, ...renderProviderAttempts(history)]
        : [];
    return [
        `❌ Meme generation failed.`,
        ``,
        "```",
        message,
        "```",
        ...attempts,
    ].join("\n");
}

/** Build the Slack webhook payload for a successful generation. */
export function buildSlackSuccessPayload({memeId, provider, title, requester, channel, repo, metadata}: {
    memeId: string; provider: string; title: string; requester: string; channel: string; repo: string; metadata?: GenerationMetadata;
}): SlackPayload {
    const costCents = formatCostCents(metadata);
    return {
        status:    "success",
        image_url: `https://raw.githubusercontent.com/${repo}/refs/heads/main/memes/${memeId}.jpg`,
        title,
        requester,
        channel,
        error:     "",
        provider,
        // Slack renders text only; send the pre-formatted display string.
        ...(costCents == null ? {} : {cost_cents: costCents}),
    };
}

interface RawNotifier {
    notifySuccess(params: NotifySuccessParams): Effect.Effect<void, never, NotifierDeps>;
    notifyFailure(message: string, closeNotPlanned?: boolean, history?: ReadonlyArray<HistoryEntry>): Effect.Effect<void, never, NotifierDeps>;
}

const makeNotifier = (): RawNotifier => ({
    notifySuccess: ({memeId, history, prompt, metadata}) => Effect.gen(function* () {
        const config   = yield* AppConfigService;
        const provider = history.find((e) => e.status === "success")?.provider ?? "unknown";
        yield* postComment(buildSuccessComment({memeId, provider, history, prompt, requester: config.requester, channel: config.channel, slackLink: config.slackLink, repo: config.repo, metadata}));
        yield* exec(`gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed`).pipe(Effect.ignore);
        yield* Effect.log(`Issue #${config.issueNumber} closed.`);
        yield* postSlack(buildSlackSuccessPayload({memeId, provider, title: config.memePrompt, requester: config.requester, channel: config.channel, repo: config.repo, metadata}));
    }),

    notifyFailure: (message, closeNotPlanned = false, history) => Effect.gen(function* () {
        const config = yield* AppConfigService;
        yield* postComment(buildFailureComment(message, history));
        yield* postSlack({status: "failure", image_url: "", title: config.memePrompt, requester: config.requester, channel: config.channel, error: message});
        if (closeNotPlanned) {
            yield* exec(`gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed -f state_reason=not_planned`).pipe(Effect.ignore);
        }
    }),
});

export const NotifierLayer: Layer.Layer<NotifierServiceTag, never, CommandExecutor.CommandExecutor | AppConfigService | FileSystem.FileSystem> =
    Layer.effect(
        NotifierServiceTag,
        Effect.gen(function* () {
            // Capture dependencies once, at layer construction, and provide them
            // to the service methods so their effects require nothing (R = never).
            const executor = yield* CommandExecutor.CommandExecutor;
            const config   = yield* AppConfigService;
            const fs       = yield* FileSystem.FileSystem;
            const provideDeps = <A>(effect: Effect.Effect<A, never, NotifierDeps>): Effect.Effect<A> =>
                effect.pipe(
                    Effect.provideService(CommandExecutor.CommandExecutor, executor),
                    Effect.provideService(AppConfigService, config),
                    Effect.provideService(FileSystem.FileSystem, fs),
                );
            const notifier = makeNotifier();
            return {
                notifySuccess: (params) => provideDeps(notifier.notifySuccess(params)),
                notifyFailure: (message, closeNotPlanned, history) => provideDeps(notifier.notifyFailure(message, closeNotPlanned, history)),
            } satisfies NotifierService;
        }),
    );
