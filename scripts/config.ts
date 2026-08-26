import * as ConfigError from "effect/ConfigError";
import {Config, Context, Effect, Layer, Schema} from "effect";

export interface AppConfig {
    issueNumber:     string;
    repo:            string;
    slackWebhookUrl: string;
    requester:       string;
    memePrompt:      string;
    channel:         string;
    slackLink:       string;
}

export class AppConfigService extends Context.Tag("AppConfigService")<AppConfigService, AppConfig>() {}
export const AppConfigLayer = Layer.effect(AppConfigService, Effect.gen(function* () {
    const {repo, slackWebhookUrl, issueNumber, issueBody} = yield* Config.all({
        repo:            Config.string("REPO"),
        slackWebhookUrl: Config.string("SLACK_WEBHOOK_URL"),
        issueNumber:     Config.string("ISSUE_NUMBER"),
        issueBody:       Config.string("ISSUE_BODY"),
    });

    const fields = yield* parseIssueBody(issueBody).pipe(
        Effect.mapError((e) => ConfigError.InvalidData(["ISSUE_BODY"], e.message)),
    );

    return {issueNumber, repo, slackWebhookUrl, requester: fields.sender, memePrompt: fields.message, channel: fields.channel, slackLink: fields.link};
}));

export const parseIssueBody = (body: string) => Schema.decodeUnknown(IssueFields)(tokenizeIssueBody(body));


export class IssueFields extends Schema.Class<IssueFields>("IssueFields")({
    sender:  Schema.NonEmptyTrimmedString,
    message: Schema.NonEmptyTrimmedString,
    channel: Schema.NonEmptyTrimmedString,
    link:    Schema.NonEmptyTrimmedString,
}) {}

// Keys emitted by the Slack workflow that files these issues. Only these start a
// new field; any other line is treated as a continuation of the current value so
// that multi-line messages (which may themselves contain "word: ..." lines, e.g.
// "Rune: :sadpepe:") are preserved instead of being truncated at the first line.
const KNOWN_KEYS = new Set(["sender", "channel", "message", "link", "timestamp"]);

function tokenizeIssueBody(body: string): Record<string, string> {
    const result: Record<string, string> = {};
    let currentKey: string | null = null;
    for (const rawLine of (body ?? "").split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        const sep = line.indexOf(": ");
        const potentialKey = sep !== -1 ? line.slice(0, sep).trim().toLowerCase() : null;
        if (potentialKey != null && KNOWN_KEYS.has(potentialKey)) {
            currentKey = potentialKey;
            result[currentKey] = line.slice(sep + 2).trim();
        } else if (currentKey != null && line.trim() !== "") {
            result[currentKey] += "\n" + line;
        }
    }
    return result;
}

