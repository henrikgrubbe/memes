import {Config, Context, Effect, Layer} from "effect";
import {IssueBodyMissingFieldError} from "./errors.js";

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

export function parseIssueBody(body: string): Record<string, string> {
    const knownFields = new Set(["sender", "message", "channel", "link"]);
    const result: Record<string, string> = {};
    let currentKey: string | null = null;
    for (const rawLine of (body ?? "").split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        const sep = line.indexOf(": ");
        const potentialKey = sep !== -1 ? line.slice(0, sep).trim().toLowerCase() : null;
        if (potentialKey != null && knownFields.has(potentialKey)) {
            currentKey = potentialKey;
            result[currentKey] = line.slice(sep + 2).trim();
        } else if (currentKey != null && line.trim() !== "") {
            result[currentKey] += "\n" + line;
        }
    }
    return result;
}

export const AppConfigLayer = Layer.effect(AppConfigService, Effect.gen(function* () {
    const repo            = yield* Config.string("REPO");
    const slackWebhookUrl = yield* Config.string("SLACK_WEBHOOK_URL");
    const issueNumber     = yield* Config.string("ISSUE_NUMBER");
    const issueBody       = yield* Config.string("ISSUE_BODY");

    const fields       = parseIssueBody(issueBody);
    const requireField = (key: string): Effect.Effect<string, IssueBodyMissingFieldError> =>
        fields[key] != null ? Effect.succeed(fields[key]) : Effect.fail(new IssueBodyMissingFieldError(key));

    const requester  = yield* requireField("sender");
    const memePrompt = yield* requireField("message");
    const channel    = yield* requireField("channel");
    const slackLink  = yield* requireField("link");

    return {issueNumber, repo, slackWebhookUrl, requester, memePrompt, channel, slackLink};
}));
