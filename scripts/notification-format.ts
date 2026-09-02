import type { GenerationMetadata } from "./providers.js";
import { renderProviderAttempts, type HistoryEntry } from "./history.js";

interface SuccessCommentParams {
  readonly memeId: string;
  readonly provider: string;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly prompt: string;
  readonly requester: string;
  readonly channel: string;
  readonly slackLink: string;
  readonly repo: string;
  readonly metadata?: GenerationMetadata;
}

interface SlackSuccessParams {
  readonly memeId: string;
  readonly provider: string;
  readonly title: string;
  readonly requester: string;
  readonly channel: string;
  readonly repo: string;
  readonly metadata?: GenerationMetadata;
}

interface SlackFailureParams {
  readonly title: string;
  readonly requester: string;
  readonly channel: string;
  readonly error: string;
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
}

/** Display-ready cost string (e.g. "0.108¢"), or null when cost is unknown. */
export function formatCostCents(metadata?: GenerationMetadata): string | null {
  const costCents = metadata?.costCents;
  return costCents == null ? null : `${costCents.toFixed(3)}¢`;
}

const inlineCode = (value: string): string =>
  value.includes("`") ? `\`\`${value}\`\`` : `\`${value}\``;

export function formatSuccessComment({
  memeId,
  provider,
  history,
  prompt,
  requester,
  channel,
  slackLink,
  repo,
  metadata,
}: SuccessCommentParams): string {
  const providerNote = ` _(${provider})_`;
  const promptDisplay = inlineCode(prompt);
  const revisedPrompt = metadata?.revisedPrompt;
  const revisedPromptDisplay =
    revisedPrompt == null ? null : inlineCode(revisedPrompt);
  const usageSummary =
    metadata?.usage == null
      ? null
      : `${metadata.usage.inputTokens} input, ${metadata.usage.outputTokens} output, ${metadata.usage.totalTokens} total tokens`;
  const costCents = formatCostCents(metadata);
  const blobUrl = `https://github.com/${repo}/blob/main/memes/${memeId}.jpg`;
  const imageUrl = `https://raw.githubusercontent.com/${repo}/refs/heads/main/memes/${memeId}.jpg`;

  return [
    `🎉 Meme generated and committed to [memes/${memeId}.jpg](${blobUrl})${providerNote}`,
    ``,
    `![Generated meme](${imageUrl})`,
    ``,
    `**Requested by:** ${requester} in ${channel} - [View in Slack](${slackLink})`,
    `**Prompt:** ${promptDisplay}`,
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
  memeId,
  provider,
  title,
  requester,
  channel,
  repo,
  metadata,
}: SlackSuccessParams) {
  const costCents = formatCostCents(metadata);
  return {
    status: "success" as const,
    content_url: `https://raw.githubusercontent.com/${repo}/refs/heads/main/memes/${memeId}.jpg`,
    title,
    requester,
    channel,
    error: "",
    provider,
    ...(costCents == null ? {} : { cost_cents: costCents }),
  };
}

/** Format the Slack webhook payload for a failed generation. */
export function formatSlackFailurePayload({
  title,
  requester,
  channel,
  error,
}: SlackFailureParams) {
  return {
    status: "failure" as const,
    content_url: "",
    title,
    requester,
    channel,
    error,
  };
}

export function formatSlackSagaUpdatePayload({
  saga,
  contribution,
  updated,
  requester,
  channel,
  repo,
}: SlackSagaUpdateParams) {
  return {
    status: updated
      ? ("saga-updated" as const)
      : ("saga-update-failed" as const),
    content_url: updated
      ? `https://github.com/${repo}/blob/main/context/${saga}.md`
      : "",
    title: `Saga "${saga}": ${contribution}`,
    requester,
    channel,
    error: updated ? "" : `Saga "${saga}" could not be updated.`,
  };
}
