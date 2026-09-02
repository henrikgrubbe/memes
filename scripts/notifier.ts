import { Context, Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { type AppConfig, AppConfigService } from "./config.js";
import type { GenerationMetadata } from "./providers.js";
import type { HistoryEntry } from "./history.js";
import {
  formatFailureComment,
  formatSagaUpdateComment,
  formatSlackFailurePayload,
  formatSlackSagaUpdatePayload,
  formatSlackSuccessPayload,
  formatSuccessComment,
} from "./notification-format.js";
import { type Shell, ShellTag } from "./shell.js";

const SlackPayloadSchema = Schema.Struct({
  status: Schema.Literal(
    "success",
    "failure",
    "saga-updated",
    "saga-update-failed",
  ),
  content_url: Schema.String,
  title: Schema.String,
  requester: Schema.String,
  channel: Schema.String,
  error: Schema.String,
  provider: Schema.optional(Schema.String),
  cost_cents: Schema.optional(Schema.String),
  read_saga: Schema.optional(Schema.String),
  write_saga: Schema.optional(Schema.String),
});

type SlackPayload = Schema.Schema.Type<typeof SlackPayloadSchema>;

export interface NotifySuccessParams {
  readonly memeId: string;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly prompt: string;
  readonly metadata?: GenerationMetadata;
}

export interface NotifySagaUpdateParams {
  readonly saga: string;
  readonly contribution: string;
  readonly updated: boolean;
}

// Deep interface: callers describe what happened; delivery orchestration
// remains behind this seam.

export interface NotifierService {
  readonly notifySuccess: (params: NotifySuccessParams) => Effect.Effect<void>;
  readonly notifySagaUpdate: (
    params: NotifySagaUpdateParams,
  ) => Effect.Effect<void>;
  readonly notifyFailure: (
    message: string,
    closeNotPlanned?: boolean,
    history?: ReadonlyArray<HistoryEntry>,
  ) => Effect.Effect<void>;
}

export class NotifierServiceTag extends Context.Tag("NotifierService")<
  NotifierServiceTag,
  NotifierService
>() {}

const postComment = (
  config: AppConfig,
  shell: Shell,
  body: string,
): Effect.Effect<void> =>
  shell
    .runWithBodyFile(
      "txt",
      body,
      (file) =>
        `gh issue comment ${config.issueNumber} --repo ${config.repo} --body-file ${file}`,
    )
    .pipe(Effect.ignore);

const postSlack = (
  config: AppConfig,
  shell: Shell,
  payload: SlackPayload,
): Effect.Effect<void> =>
  Schema.encode(Schema.parseJson(SlackPayloadSchema))(payload).pipe(
    Effect.orDie,
    Effect.flatMap((json) =>
      shell.runWithBodyFile(
        "json",
        json,
        (file) =>
          `curl -s -X POST -H 'Content-Type: application/json' -d @${file} '${config.slackWebhookUrl}'`,
      ),
    ),
    Effect.ignore,
  );

const closeIssue = (
  config: AppConfig,
  shell: Shell,
  reason?: "not_planned",
): Effect.Effect<void> =>
  shell
    .run(
      `gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed` +
        (reason == null ? "" : ` -f state_reason=${reason}`),
    )
    .pipe(Effect.ignore);

const makeNotifier = (config: AppConfig, shell: Shell): NotifierService => ({
  notifySuccess: ({ memeId, history, prompt, metadata }) =>
    Effect.gen(function* () {
      const provider =
        history.find(({ status }) => status === "success")?.provider ??
        "unknown";

      yield* postComment(
        config,
        shell,
        formatSuccessComment({
          memeId,
          provider,
          history,
          prompt,
          requester: config.requester,
          channel: config.channel,
          slackLink: config.slackLink,
          repo: config.repo,
          metadata,
        }),
      );
      yield* closeIssue(config, shell);
      yield* Effect.log(`Issue #${config.issueNumber} closed.`);
      yield* postSlack(
        config,
        shell,
        formatSlackSuccessPayload({
          memeId,
          provider,
          title: config.memePrompt,
          requester: config.requester,
          channel: config.channel,
          repo: config.repo,
          metadata,
          readSaga: config.readSaga ?? undefined,
          writeSaga: config.writeSaga ?? undefined,
        }),
      );
    }),

  notifySagaUpdate: ({ saga, contribution, updated }) =>
    Effect.gen(function* () {
      yield* postComment(
        config,
        shell,
        formatSagaUpdateComment({ saga, contribution, updated }),
      );
      yield* updated ? closeIssue(config, shell) : Effect.void;
      yield* postSlack(
        config,
        shell,
        formatSlackSagaUpdatePayload({
          saga,
          contribution,
          updated,
          requester: config.requester,
          channel: config.channel,
          repo: config.repo,
        }),
      );
    }),

  notifyFailure: (message, closeNotPlanned = false, history) =>
    Effect.gen(function* () {
      yield* postComment(config, shell, formatFailureComment(message, history));
      yield* postSlack(
        config,
        shell,
        formatSlackFailurePayload({
          title: config.memePrompt,
          requester: config.requester,
          channel: config.channel,
          error: message,
          readSaga: config.readSaga ?? undefined,
          writeSaga: config.writeSaga ?? undefined,
        }),
      );
      yield* closeNotPlanned
        ? closeIssue(config, shell, "not_planned")
        : Effect.void;
    }),
});

export const NotifierLayer: Layer.Layer<
  NotifierServiceTag,
  never,
  ShellTag | AppConfigService
> = Layer.effect(
  NotifierServiceTag,
  Effect.gen(function* () {
    const shell = yield* ShellTag;
    const config = yield* AppConfigService;

    return makeNotifier(config, shell);
  }),
);
