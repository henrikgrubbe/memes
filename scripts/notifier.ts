import {Command, CommandExecutor, FileSystem} from "@effect/platform";
import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {AppConfigService} from "./config.js";
import type {GenerationMetadata, HistoryEntry} from "./providers.js";

// ---- Types ------------------------------------------------------------------

const SlackPayload = Schema.Struct({
    status:    Schema.Literal("success", "failure"),
    image_url: Schema.String,
    title:     Schema.String,
    requester: Schema.String,
    channel:   Schema.String,
    error:     Schema.String,
    provider:  Schema.optional(Schema.String),
});
type SlackPayload = Schema.Schema.Type<typeof SlackPayload>;

export interface NotifySuccessParams {
    memeId:   string;
    history:  HistoryEntry[];
    prompt:   string;
    twist:    string | null;
    metadata?: GenerationMetadata;
}

// ---- NotifierService --------------------------------------------------------
// Deep interface: callers describe what happened; how to post, format, and
// encode all lives behind this seam.

export interface NotifierService {
    notifySuccess(params: NotifySuccessParams): Effect.Effect<void>;
    notifyFailure(message: string, closeNotPlanned?: boolean): Effect.Effect<void>;
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

function buildSuccessComment({memeId, provider, history, prompt, twist, requester, channel, slackLink, metadata}: {
    memeId: string; provider: string; history: HistoryEntry[];
    prompt: string; twist: string | null; requester: string; channel: string; slackLink: string; repo: string; metadata?: GenerationMetadata;
}): string {
    const providerNote  = ` _(${[provider, twist].filter((x) => x != null).join(" - ")})_`;
    const promptDisplay = prompt.includes("`") ? `\`\`${prompt}\`\`` : `\`${prompt}\``;
    const revisedPrompt = metadata?.revisedPrompt;
    const revisedPromptDisplay = revisedPrompt == null
        ? null
        : (revisedPrompt.includes("`") ? `\`\`${revisedPrompt}\`\`` : `\`${revisedPrompt}\``);
    const usageSummary = metadata?.usage == null
        ? null
        : `${metadata.usage.inputTokens} input, ${metadata.usage.outputTokens} output, ${metadata.usage.totalTokens} total tokens`;
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
        ...(usageSummary == null
            ? []
            : [
                `**Usage:** ${usageSummary}`,
                `**Estimated cost:** unavailable from provider response`,
                `**Remaining balance:** unavailable from provider response`,
            ]),
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

const makeNotifier = (): NotifierService => ({
    notifySuccess: ({memeId, history, prompt, twist, metadata}) => Effect.gen(function* () {
        const config   = yield* AppConfigService;
        const provider = history.find((e) => e.status === "success")?.provider ?? "unknown";
        yield* postComment(buildSuccessComment({memeId, provider, history, prompt, twist, requester: config.requester, channel: config.channel, slackLink: config.slackLink, repo: config.repo, metadata}));
        yield* exec(`gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed`).pipe(Effect.ignore);
        yield* Effect.log(`Issue #${config.issueNumber} closed.`);
        const imageUrl = `https://raw.githubusercontent.com/${config.repo}/refs/heads/main/memes/${memeId}.jpg`;
        yield* postSlack({status: "success", image_url: imageUrl, title: config.memePrompt, requester: config.requester, channel: config.channel, error: "", provider});
    }),

    notifyFailure: (message, closeNotPlanned = false) => Effect.gen(function* () {
        const config = yield* AppConfigService;
        yield* postComment(`❌ Meme generation failed.\n\n\`\`\`\n${message}\n\`\`\``);
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
            // Yield deps here so the layer type accurately declares its requirements.
            // The service methods close over these via context at runtime.
            yield* CommandExecutor.CommandExecutor;
            yield* AppConfigService;
            yield* FileSystem.FileSystem;
            return makeNotifier();
        }),
    );
