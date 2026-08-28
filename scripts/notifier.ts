import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {AppConfigService} from "./config.js";
import {ShellTag} from "./shell.js";
import type {GenerationMetadata} from "./providers.js";
import type {HistoryEntry} from "./history.js";
import {
    formatFailureComment,
    formatSlackFailurePayload,
    formatSlackSuccessPayload,
    formatSuccessComment,
} from "./notification-format.js";

// ---- Types ------------------------------------------------------------------

const SlackPayloadSchema = Schema.Struct({
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
type SlackPayload = Schema.Schema.Type<typeof SlackPayloadSchema>;

export interface NotifySuccessParams {
    memeId:   string;
    history:  HistoryEntry[];
    prompt:   string;
    metadata?: GenerationMetadata;
}

// ---- NotifierService --------------------------------------------------------
// Deep interface: callers describe what happened; delivery orchestration
// remains behind this seam.

export interface NotifierService {
    notifySuccess(params: NotifySuccessParams): Effect.Effect<void>;
    notifyFailure(message: string, closeNotPlanned?: boolean, history?: ReadonlyArray<HistoryEntry>): Effect.Effect<void>;
}

export class NotifierServiceTag extends Context.Tag("NotifierService")<NotifierServiceTag, NotifierService>() {}

// ---- Real adapter -----------------------------------------------------------

type NotifierDeps = ShellTag | AppConfigService;

const postComment = (body: string): Effect.Effect<void, never, NotifierDeps> =>
    Effect.gen(function* () {
        const config = yield* AppConfigService;
        const shell  = yield* ShellTag;
        yield* shell.runWithBodyFile("txt", body, (tmp) =>
            `gh issue comment ${config.issueNumber} --repo ${config.repo} --body-file ${tmp}`,
        ).pipe(Effect.ignore);
    });

const postSlack = (data: SlackPayload): Effect.Effect<void, never, NotifierDeps> =>
    Effect.gen(function* () {
        const config = yield* AppConfigService;
        const shell  = yield* ShellTag;
        const json   = yield* Schema.encode(Schema.parseJson(SlackPayloadSchema))(data).pipe(Effect.orDie);
        yield* shell.runWithBodyFile("json", json, (tmp) =>
            `curl -s -X POST -H 'Content-Type: application/json' -d @${tmp} '${config.slackWebhookUrl}'`,
        ).pipe(Effect.ignore);
    });

interface RawNotifier {
    notifySuccess(params: NotifySuccessParams): Effect.Effect<void, never, NotifierDeps>;
    notifyFailure(message: string, closeNotPlanned?: boolean, history?: ReadonlyArray<HistoryEntry>): Effect.Effect<void, never, NotifierDeps>;
}

const makeNotifier = (): RawNotifier => ({
    notifySuccess: ({memeId, history, prompt, metadata}) => Effect.gen(function* () {
        const config   = yield* AppConfigService;
        const shell    = yield* ShellTag;
        const provider = history.find((e) => e.status === "success")?.provider ?? "unknown";
        yield* postComment(formatSuccessComment({memeId, provider, history, prompt, requester: config.requester, channel: config.channel, slackLink: config.slackLink, repo: config.repo, metadata}));
        yield* shell.run(`gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed`).pipe(Effect.ignore);
        yield* Effect.log(`Issue #${config.issueNumber} closed.`);
        yield* postSlack(formatSlackSuccessPayload({memeId, provider, title: config.memePrompt, requester: config.requester, channel: config.channel, repo: config.repo, metadata}));
    }),

    notifyFailure: (message, closeNotPlanned = false, history) => Effect.gen(function* () {
        const config = yield* AppConfigService;
        const shell  = yield* ShellTag;
        yield* postComment(formatFailureComment(message, history));
        yield* postSlack(formatSlackFailurePayload({title: config.memePrompt, requester: config.requester, channel: config.channel, error: message}));
        if (closeNotPlanned) {
            yield* shell.run(`gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed -f state_reason=not_planned`).pipe(Effect.ignore);
        }
    }),
});

export const NotifierLayer: Layer.Layer<NotifierServiceTag, never, ShellTag | AppConfigService> =
    Layer.effect(
        NotifierServiceTag,
        Effect.gen(function* () {
            // Capture dependencies once, at layer construction, and provide them
            // to the service methods so their effects require nothing (R = never).
            const shell  = yield* ShellTag;
            const config = yield* AppConfigService;
            const provideDeps = <A>(effect: Effect.Effect<A, never, NotifierDeps>): Effect.Effect<A> =>
                effect.pipe(
                    Effect.provideService(ShellTag, shell),
                    Effect.provideService(AppConfigService, config),
                );
            const notifier = makeNotifier();
            return {
                notifySuccess: (params) => provideDeps(notifier.notifySuccess(params)),
                notifyFailure: (message, closeNotPlanned, history) => provideDeps(notifier.notifyFailure(message, closeNotPlanned, history)),
            } satisfies NotifierService;
        }),
    );
