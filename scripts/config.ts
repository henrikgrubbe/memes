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
    const repo            = yield* Config.string("REPO");
    const slackWebhookUrl = yield* Config.string("SLACK_WEBHOOK_URL");
    const issueNumber     = yield* Config.string("ISSUE_NUMBER");
    const issueBody       = yield* Config.string("ISSUE_BODY");

    const fields = yield* parseIssueBody(issueBody);

    return {issueNumber, repo, slackWebhookUrl, requester: fields.sender, memePrompt: fields.message, channel: fields.channel, slackLink: fields.link};
}));

export const parseIssueBody = (body: string) => Schema.decodeUnknown(IssueFields)(tokenizeIssueBody(body));


export class IssueFields extends Schema.Class<IssueFields>("IssueFields")({
    sender:  Schema.NonEmptyTrimmedString,
    message: Schema.NonEmptyTrimmedString,
    channel: Schema.NonEmptyTrimmedString,
    link:    Schema.NonEmptyTrimmedString,
}) {}

function tokenizeIssueBody(body: string): Record<string, string> {
    const result: Record<string, string> = {};
    let currentKey: string | null = null;
    for (const rawLine of (body ?? "").split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        const sep = line.indexOf(": ");
        const potentialKey = sep !== -1 ? line.slice(0, sep).trim().toLowerCase() : null;
        if (potentialKey != null) {
            currentKey = potentialKey;
            result[currentKey] = line.slice(sep + 2).trim();
        } else if (currentKey != null && line.trim() !== "") {
            result[currentKey] += "\n" + line;
        }
    }
    return result;
}

