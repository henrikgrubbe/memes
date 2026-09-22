import { Clock, Effect, Schema } from "effect";
import type { AppConfig } from "../../shared/config.js";
import { NotificationError } from "../../shared/errors.js";
import type { HistoryEntry } from "../../shared/history.js";
import type { GenerationMetadata } from "../../shared/providers.js";
import type { DeliveryOutcome } from "./hosted-delivery.js";
import type {
  HostedGitHubError,
  HostedGitHubRepository,
} from "./hosted-github.js";

interface SuccessCommentParams {
  readonly channel: string;
  readonly elapsed: Elapsed | null;
  readonly generationPrompt?: string;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly imageUrl: string;
  readonly metadata?: GenerationMetadata;
  readonly provider: string;
  readonly requestedPrompt: string;
  readonly requester: string;
  readonly slackLink: string;
}

// How long the request took end to end, from the moment ingress accepted the
// webhook to the moment the worker reports completion. Measured against the
// task's own `requestedAt` stamp, so it survives queue wait and retries.
interface Elapsed {
  readonly text: string;
}

const formatElapsed = (totalSeconds: number): string => {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
};

// Defensive: `requestedAt` crosses a queue boundary and is optional on the wire,
// so an absent, unparseable, or clock-skewed value simply omits the timing
// rather than rendering nonsense like "-3s".
const elapsedSince = (
  requestedAt: string | null,
  nowMillis: number,
): Elapsed | null => {
  if (requestedAt == null) {
    return null;
  }
  const startedAt = Date.parse(requestedAt);
  if (Number.isNaN(startedAt)) {
    return null;
  }
  const elapsedMillis = nowMillis - startedAt;
  if (elapsedMillis < 0) {
    return null;
  }
  const seconds = Math.round(elapsedMillis / 1000);
  return { text: formatElapsed(seconds) };
};

const elapsedCommentLines = (elapsed: Elapsed | null): ReadonlyArray<string> =>
  elapsed == null ? [] : [`**Took:** ${elapsed.text}`];

const formatCostCents = (metadata?: GenerationMetadata): string | null => {
  const costCents = metadata?.costCents;
  return costCents == null ? null : `${costCents.toFixed(3)}¢`;
};

const inlineCode = (value: string): string =>
  value.includes("`") ? `\`\`${value}\`\`` : `\`${value}\``;

const fencedCode = (value: string): ReadonlyArray<string> => {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), ([run]) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [`${fence}text`, value, fence];
};

const renderProviderAttempts = (
  history: ReadonlyArray<HistoryEntry>,
): ReadonlyArray<string> =>
  history.map(({ provider, status, message }) => {
    switch (status) {
      case "success":
        return `- ${provider} ✅`;
      case "rate-limited":
        return `- ${provider} ⏳ rate limited`;
      case "failed":
        return `- ${provider} ❌ (${message})`;
    }
  });

const successComment = ({
  channel,
  elapsed,
  generationPrompt,
  history,
  imageUrl,
  metadata,
  provider,
  requestedPrompt,
  requester,
  slackLink,
}: SuccessCommentParams): string => {
  const fullPromptDetails =
    generationPrompt == null || generationPrompt === requestedPrompt
      ? []
      : [
          ``,
          `<details>`,
          `<summary><strong>Full generation prompt</strong></summary>`,
          ``,
          ...fencedCode(generationPrompt),
          `</details>`,
        ];
  const revisedPrompt = metadata?.revisedPrompt;
  const usageSummary =
    metadata?.usage == null
      ? null
      : `${metadata.usage.inputTokens} input, ${metadata.usage.outputTokens} output, ${metadata.usage.totalTokens} total tokens`;
  const costCents = formatCostCents(metadata);

  return [
    `🎉 [Meme generated](${imageUrl}) _(${provider})_`,
    ``,
    `![Generated meme](${imageUrl})`,
    ``,
    `**Requested by:** ${requester} in ${channel} - [View in Slack](${slackLink})`,
    `**Requested prompt:** ${inlineCode(requestedPrompt)}`,
    ...fullPromptDetails,
    ...(revisedPrompt == null
      ? []
      : [`**Revised prompt:** ${inlineCode(revisedPrompt)}`]),
    ...(usageSummary == null ? [] : [`**Usage:** ${usageSummary}`]),
    ...(costCents == null ? [] : [`**Estimated cost:** ${costCents}`]),
    ...elapsedCommentLines(elapsed),
    ``,
    `**Provider attempts:**`,
    ...renderProviderAttempts(history),
  ].join("\n");
};

const failureComment = (
  message: string,
  elapsed: Elapsed | null,
  history?: ReadonlyArray<HistoryEntry>,
): string => {
  const attempts =
    history != null && history.length > 0
      ? [``, `**Provider attempts:**`, ...renderProviderAttempts(history)]
      : [];
  const timing = elapsed == null ? [] : [``, ...elapsedCommentLines(elapsed)];
  return [
    `❌ Meme generation failed.`,
    ``,
    "```",
    message,
    "```",
    ...attempts,
    ...timing,
  ].join("\n");
};

const sagaUpdateComment = ({
  contribution,
  saga,
  updated,
}: Extract<DeliveryOutcome, { readonly kind: "saga-updated" }>): string => {
  const status = updated
    ? `✅ Saga \`${saga}\` updated.`
    : `❌ Saga \`${saga}\` could not be updated. The issue remains open.`;
  return [status, ``, `**Contribution:** ${inlineCode(contribution)}`].join(
    "\n",
  );
};

const sagaContextComment = ({
  canon,
  saga,
}: Extract<DeliveryOutcome, { readonly kind: "saga-context" }>): string =>
  canon.trim() === ""
    ? `📖 Saga \`${saga}\` has no context yet.`
    : [
        `📖 Current context for saga \`${saga}\`:`,
        ``,
        ...fencedCode(canon),
      ].join("\n");

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

interface SlackCompletionPayload {
  readonly channel: string;
  readonly content_url: string;
  readonly cost_cents: string;
  readonly meme_id: string;
  readonly read_sagas: string;
  readonly requester: string;
  readonly text: string;
  readonly title: string;
  readonly type: "failure" | "image" | "saga-context" | "saga-updated";
  readonly write_saga: string;
}

const slackPayload = (
  config: AppConfig,
  fields: Pick<
    SlackCompletionPayload,
    "content_url" | "text" | "title" | "type"
  > &
    Partial<
      Pick<SlackCompletionPayload, "cost_cents" | "meme_id" | "write_saga">
    >,
): SlackCompletionPayload => ({
  channel: config.channel,
  content_url: fields.content_url,
  cost_cents: fields.cost_cents ?? "",
  meme_id: fields.meme_id ?? "",
  read_sagas: config.readSagas.join(", "),
  requester: config.requester,
  text: fields.text,
  title: fields.title,
  type: fields.type,
  write_saga: fields.write_saga ?? config.writeSaga ?? "",
});

const imageContextText = (readSagas: ReadonlyArray<string>): string =>
  readSagas.length === 0
    ? "No Saga context."
    : `Saga context: ${readSagas.join(", ")}`;

const completionPlan = (
  config: AppConfig,
  branch: string,
  outcome: DeliveryOutcome,
  elapsed: Elapsed | null,
): CompletionPlan => {
  switch (outcome.kind) {
    case "success": {
      const costCents = formatCostCents(outcome.metadata);
      return {
        close: true,
        comment: successComment({
          channel: config.channel,
          elapsed,
          generationPrompt: outcome.generationPrompt,
          history: outcome.history,
          imageUrl: outcome.imageUrl,
          metadata: outcome.metadata,
          provider: outcome.provider,
          requestedPrompt: outcome.prompt,
          requester: config.requester,
          slackLink: config.slackLink,
        }),
        slackPayload: slackPayload(config, {
          type: "image",
          content_url: outcome.imageUrl,
          title: config.memePrompt,
          text: imageContextText(config.readSagas),
          cost_cents: costCents ?? "not reported",
          meme_id: outcome.memeId,
        }),
      };
    }
    case "saga-updated":
      return {
        close: outcome.updated,
        comment: sagaUpdateComment(outcome),
        slackPayload: slackPayload(config, {
          type: outcome.updated ? "saga-updated" : "failure",
          content_url: outcome.updated
            ? `https://github.com/${config.repo}/blob/${branch}/context/${outcome.saga}.md`
            : "",
          title: `Saga "${outcome.saga}": ${outcome.contribution}`,
          text: outcome.updated
            ? ""
            : `Saga "${outcome.saga}" could not be updated.`,
          write_saga: outcome.saga,
        }),
      };
    case "saga-context":
      return {
        close: true,
        comment: sagaContextComment(outcome),
        slackPayload: slackPayload(config, {
          type: "saga-context",
          content_url: `https://github.com/${config.repo}/blob/${branch}/context/${outcome.saga}.md`,
          title: `Current context for Saga "${outcome.saga}"`,
          text:
            outcome.canon.trim() === ""
              ? `Saga "${outcome.saga}" has no context yet.`
              : outcome.canon,
        }),
      };
    case "failure":
      return {
        close: outcome.closeNotPlanned,
        ...(outcome.closeNotPlanned
          ? { closeReason: "not_planned" as const }
          : {}),
        comment: failureComment(outcome.message, elapsed, outcome.history),
        slackPayload: slackPayload(config, {
          type: "failure",
          content_url: "",
          title: config.memePrompt,
          text: outcome.message,
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
    const now = yield* Clock.currentTimeMillis;
    const elapsed = elapsedSince(config.requestedAt, now);
    const plan = completionPlan(config, repository.branch, outcome, elapsed);
    yield* slack.post(plan.slackPayload);
    yield* repository.commentOnce(plan.comment);
    if (plan.close) {
      yield* repository.closeIssue(plan.closeReason);
    }
  });
