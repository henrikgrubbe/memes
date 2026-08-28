import type {GenerationMetadata} from "./providers.js";
import {renderProviderAttempts, type HistoryEntry} from "./history.js";

/** Display-ready cost string (e.g. "0.108¢"), or null when cost is unknown. */
export function formatCostCents(metadata?: GenerationMetadata): string | null {
    const costCents = metadata?.costCents;
    return costCents == null ? null : `${costCents.toFixed(3)}¢`;
}

export function formatSuccessComment({memeId, provider, history, prompt, requester, channel, slackLink, repo, metadata}: {
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

/** Format the issue comment for a failed generation, including any attempt history. */
export function formatFailureComment(message: string, history?: ReadonlyArray<HistoryEntry>): string {
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

/** Format the Slack webhook payload for a successful generation. */
export function formatSlackSuccessPayload({memeId, provider, title, requester, channel, repo, metadata}: {
    memeId: string; provider: string; title: string; requester: string; channel: string; repo: string; metadata?: GenerationMetadata;
}) {
    const costCents = formatCostCents(metadata);
    return {
        status:    "success" as const,
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

/** Format the Slack webhook payload for a failed generation. */
export function formatSlackFailurePayload({title, requester, channel, error}: {
    title: string; requester: string; channel: string; error: string;
}) {
    return {
        status: "failure" as const,
        image_url: "",
        title,
        requester,
        channel,
        error,
    };
}
