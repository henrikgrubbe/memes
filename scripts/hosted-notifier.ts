import { Effect, Layer, Schema } from "effect";
import type { AppConfig } from "./config.js";
import { NotificationError } from "./errors.js";
import type {
  CompletedDeliveryState,
  DeliveryOutcome,
  HostedGitHubRepository,
} from "./hosted-github.js";
import {
  formatFailureComment,
  formatSagaUpdateComment,
  formatSlackFailurePayload,
  formatSlackSagaUpdatePayload,
  formatSlackSuccessPayload,
  formatSuccessComment,
} from "./notification-format.js";
import { type NotifierService, NotifierServiceTag } from "./notifier.js";

export interface SlackSender {
  readonly post: (payload: unknown) => Effect.Effect<void, NotificationError>;
}

interface SlackSenderOptions {
  readonly fetch?: typeof fetch;
  readonly webhookUrl: string;
}

export const makeSlackSender = ({
  fetch: fetchRequest = fetch,
  webhookUrl,
}: SlackSenderOptions): SlackSender => ({
  post: (payload) =>
    Schema.encode(Schema.parseJson(Schema.Unknown))(payload).pipe(
      Effect.mapError(
        () =>
          new NotificationError({
            detail: "Slack notification payload could not be encoded",
          }),
      ),
      Effect.flatMap((body) =>
        Effect.tryPromise({
          try: () =>
            fetchRequest(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            }).then((response) => {
              if (!response.ok) {
                throw new NotificationError({
                  detail: `Slack webhook failed with HTTP ${response.status}`,
                });
              }
            }),
          catch: (error) =>
            error instanceof NotificationError
              ? error
              : new NotificationError({
                  detail: `Slack webhook failed: ${String(error)}`,
                }),
        }),
      ),
    ),
});

interface CompletionPlan {
  readonly close: boolean;
  readonly closeReason?: "not_planned";
  readonly comment: string;
  readonly slackPayload: unknown;
}

const completionPlan = (
  config: AppConfig,
  branch: string,
  outcome: DeliveryOutcome,
): CompletionPlan => {
  switch (outcome.kind) {
    case "success":
      return {
        close: true,
        comment: formatSuccessComment({
          branch,
          channel: config.channel,
          history: outcome.history,
          memeId: outcome.memeId,
          metadata: outcome.metadata,
          prompt: outcome.prompt,
          provider: outcome.provider,
          repo: config.repo,
          requester: config.requester,
          slackLink: config.slackLink,
        }),
        slackPayload: formatSlackSuccessPayload({
          branch,
          channel: config.channel,
          memeId: outcome.memeId,
          metadata: outcome.metadata,
          provider: outcome.provider,
          readSaga: config.readSaga ?? undefined,
          repo: config.repo,
          requester: config.requester,
          title: config.memePrompt,
          writeSaga: config.writeSaga ?? undefined,
        }),
      };
    case "saga-updated":
      return {
        close: outcome.updated,
        comment: formatSagaUpdateComment(outcome),
        slackPayload: formatSlackSagaUpdatePayload({
          branch,
          channel: config.channel,
          contribution: outcome.contribution,
          repo: config.repo,
          requester: config.requester,
          saga: outcome.saga,
          updated: outcome.updated,
        }),
      };
    case "failure":
      return {
        close: outcome.closeNotPlanned,
        ...(outcome.closeNotPlanned
          ? { closeReason: "not_planned" as const }
          : {}),
        comment: formatFailureComment(outcome.message, outcome.history),
        slackPayload: formatSlackFailurePayload({
          channel: config.channel,
          error: outcome.message,
          readSaga: config.readSaga ?? undefined,
          requester: config.requester,
          title: config.memePrompt,
          writeSaga: config.writeSaga ?? undefined,
        }),
      };
  }
};

const mapGitHubError = (error: { readonly message: string }) =>
  new NotificationError({ detail: error.message });

const completedState = (
  repository: HostedGitHubRepository,
): Effect.Effect<CompletedDeliveryState, NotificationError> =>
  repository.getDelivery().pipe(
    Effect.mapError(mapGitHubError),
    Effect.flatMap((state) =>
      state?.status === "completed"
        ? Effect.succeed(state)
        : Effect.fail(
            new NotificationError({
              detail: "Delivery is not complete enough to notify",
            }),
          ),
    ),
  );

export const deliverHostedCompletion = (
  config: AppConfig,
  repository: HostedGitHubRepository,
  slack: SlackSender,
): Effect.Effect<void, NotificationError> =>
  Effect.gen(function* () {
    const state = yield* completedState(repository);
    const plan = completionPlan(config, repository.branch, state.outcome);
    if (state.slack !== "claimed") {
      yield* slack.post(plan.slackPayload);
    }
    yield* repository
      .commentOnce(plan.comment)
      .pipe(Effect.mapError(mapGitHubError));
    if (plan.close) {
      yield* repository
        .closeIssue(plan.closeReason)
        .pipe(Effect.mapError(mapGitHubError));
    }
  });

export const makeHostedNotifier = (
  config: AppConfig,
  repository: HostedGitHubRepository,
  slack: SlackSender,
): NotifierService => {
  const deliver = () => deliverHostedCompletion(config, repository, slack);
  // The legacy notifier interface is total; defects reach the HTTP handler and
  // become retryable responses instead of being swallowed by this adapter.
  return {
    notifyFailure: () => deliver().pipe(Effect.orDie),
    notifySagaUpdate: () => deliver().pipe(Effect.orDie),
    notifySuccess: () => deliver().pipe(Effect.orDie),
  };
};

export const makeHostedNotifierLayer = (
  config: AppConfig,
  repository: HostedGitHubRepository,
  slack: SlackSender,
): Layer.Layer<NotifierServiceTag> =>
  Layer.succeed(
    NotifierServiceTag,
    makeHostedNotifier(config, repository, slack),
  );
