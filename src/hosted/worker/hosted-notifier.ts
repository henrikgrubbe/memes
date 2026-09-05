import { Effect, Schema } from "effect";
import type { AppConfig } from "../../shared/config.js";
import { NotificationError } from "../../shared/errors.js";
import {
  formatFailureComment,
  formatSagaUpdateComment,
  formatSlackFailurePayload,
  formatSlackSagaUpdatePayload,
  formatSlackSuccessPayload,
  formatSuccessComment,
} from "../../shared/notification-format.js";
import type { DeliveryOutcome } from "./hosted-delivery.js";
import type {
  HostedGitHubError,
  HostedGitHubRepository,
} from "./hosted-github.js";

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
          channel: config.channel,
          history: outcome.history,
          imageUrl: outcome.imageUrl,
          metadata: outcome.metadata,
          prompt: outcome.prompt,
          provider: outcome.provider,
          requester: config.requester,
          slackLink: config.slackLink,
        }),
        slackPayload: formatSlackSuccessPayload({
          channel: config.channel,
          contentUrl: outcome.imageUrl,
          metadata: outcome.metadata,
          provider: outcome.provider,
          readSaga: config.readSaga ?? undefined,
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

export const deliverHostedCompletion = (
  config: AppConfig,
  outcome: DeliveryOutcome,
  repository: HostedGitHubRepository,
  slack: SlackSender,
): Effect.Effect<void, HostedGitHubError | NotificationError> =>
  Effect.gen(function* () {
    const plan = completionPlan(config, repository.branch, outcome);
    yield* slack.post(plan.slackPayload);
    yield* repository.commentOnce(plan.comment);
    if (plan.close) {
      yield* repository.closeIssue(plan.closeReason);
    }
  });
