import type { GenerationMetadata } from "./providers.js";
import { renderProviderAttempts, type HistoryEntry } from "./history.js";

interface SuccessCommentParams {
  readonly channel: string;
  readonly generationPrompt?: string;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly imageSourceLabel?: string;
  readonly imageSourceUrl?: string;
  readonly imageUrl: string;
  readonly metadata?: GenerationMetadata;
  readonly provider: string;
  readonly requestedPrompt: string;
  readonly requester: string;
  readonly slackLink: string;
}

interface SlackSuccessParams {
  readonly channel: string;
  readonly contentUrl: string;
  readonly metadata?: GenerationMetadata;
  readonly provider: string;
  readonly readSaga?: string;
  readonly requester: string;
  readonly title: string;
  readonly writeSaga?: string;
}

interface SlackFailureParams {
  readonly title: string;
  readonly requester: string;
  readonly channel: string;
  readonly error: string;
  readonly readSaga?: string;
  readonly writeSaga?: string;
}

interface SagaUpdateParams {
  readonly saga: string;
  readonly contribution: string;
  readonly updated: boolean;
}

interface SlackSagaUpdateParams extends SagaUpdateParams {
  readonly requester: string;
  readonly channel: string;
  readonly repo: string;
  readonly branch?: string;
}

/** Display-ready cost string (e.g. "0.108¢"), or null when cost is unknown. */
export function formatCostCents(metadata?: GenerationMetadata): string | null {
  const costCents = metadata?.costCents;
  return costCents == null ? null : `${costCents.toFixed(3)}¢`;
}

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

const sagaFields = (readSaga?: string, writeSaga?: string) => ({
  ...(readSaga == null ? {} : { read_saga: readSaga }),
  ...(writeSaga == null ? {} : { write_saga: writeSaga }),
});

export function formatSuccessComment({
  channel,
  generationPrompt,
  history,
  imageSourceLabel,
  imageSourceUrl,
  imageUrl,
  metadata,
  provider,
  requestedPrompt,
  requester,
  slackLink,
}: SuccessCommentParams): string {
  const providerNote = ` _(${provider})_`;
  const requestedPromptDisplay = inlineCode(requestedPrompt);
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
  const revisedPromptDisplay =
    revisedPrompt == null ? null : inlineCode(revisedPrompt);
  const usageSummary =
    metadata?.usage == null
      ? null
      : `${metadata.usage.inputTokens} input, ${metadata.usage.outputTokens} output, ${metadata.usage.totalTokens} total tokens`;
  const costCents = formatCostCents(metadata);
  const publication =
    imageSourceUrl == null
      ? `🎉 [Meme generated](${imageUrl})${providerNote}`
      : `🎉 Meme generated and committed to [${imageSourceLabel ?? "the repository"}](${imageSourceUrl})${providerNote}`;

  return [
    publication,
    ``,
    `![Generated meme](${imageUrl})`,
    ``,
    `**Requested by:** ${requester} in ${channel} - [View in Slack](${slackLink})`,
    `**Requested prompt:** ${requestedPromptDisplay}`,
    ...fullPromptDetails,
    ...(revisedPromptDisplay == null
      ? []
      : [`**Revised prompt:** ${revisedPromptDisplay}`]),
    ...(usageSummary == null ? [] : [`**Usage:** ${usageSummary}`]),
    ...(costCents == null ? [] : [`**Estimated cost:** ${costCents}`]),
    ``,
    `**Provider attempts:**`,
    ...renderProviderAttempts(history),
  ].join("\n");
}

/** Format the issue comment for a failed generation, including any attempt history. */
export function formatFailureComment(
  message: string,
  history?: ReadonlyArray<HistoryEntry>,
): string {
  const attempts =
    history != null && history.length > 0
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

export function formatSagaUpdateComment({
  saga,
  contribution,
  updated,
}: SagaUpdateParams): string {
  const status = updated
    ? `✅ Saga \`${saga}\` updated.`
    : `❌ Saga \`${saga}\` could not be updated. The issue remains open.`;
  return [status, ``, `**Contribution:** ${inlineCode(contribution)}`].join(
    "\n",
  );
}

/** Format the Slack webhook payload for a successful generation. */
export function formatSlackSuccessPayload({
  channel,
  contentUrl,
  metadata,
  provider,
  readSaga,
  requester,
  title,
  writeSaga,
}: SlackSuccessParams) {
  const costCents = formatCostCents(metadata);
  return {
    status: "success" as const,
    content_url: contentUrl,
    title,
    requester,
    channel,
    error: "",
    provider,
    ...(costCents == null ? {} : { cost_cents: costCents }),
    ...sagaFields(readSaga, writeSaga),
  };
}

/** Format the Slack webhook payload for a failed generation. */
export function formatSlackFailurePayload({
  title,
  requester,
  channel,
  error,
  readSaga,
  writeSaga,
}: SlackFailureParams) {
  return {
    status: "failure" as const,
    content_url: "",
    title,
    requester,
    channel,
    error,
    ...sagaFields(readSaga, writeSaga),
  };
}

export function formatSlackSagaUpdatePayload({
  saga,
  contribution,
  updated,
  requester,
  channel,
  repo,
  branch = "main",
}: SlackSagaUpdateParams) {
  return {
    status: updated
      ? ("saga-updated" as const)
      : ("saga-update-failed" as const),
    content_url: updated
      ? `https://github.com/${repo}/blob/${branch}/context/${saga}.md`
      : "",
    title: `Saga "${saga}": ${contribution}`,
    requester,
    channel,
    error: updated ? "" : `Saga "${saga}" could not be updated.`,
    write_saga: saga,
  };
}
