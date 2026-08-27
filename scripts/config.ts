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
    // Optional saga (continuous-context) directives parsed from the message.
    // readSaga:  prepend that saga's canon to the prompt for continuity.
    // writeSaga: fold this meme into that saga's canon after generating.
    readSaga:        string | null;
    writeSaga:       string | null;
}

export interface SagaDirectives {
    readSaga:  string | null;
    writeSaga: string | null;
    // The message with any read:/write:/saga: tokens removed.
    prompt:    string;
}

// Matches inline saga directives like "read:heist", "write:my-saga_2" or the
// combined "saga:heist" (read + write the same saga). The name is restricted to
// a filename-safe slug; a space after the colon (e.g. "read: the news") does
// not match, avoiding false positives.
const SAGA_DIRECTIVE = /\b(read|write|saga):([A-Za-z0-9_-]+)/gi;

/**
 * Pull the first `read:` and `write:` saga directives out of a message and
 * return the cleaned prompt with all such tokens removed. The combined
 * `saga:<name>` shorthand counts as both a read and a write of that saga. Saga
 * names are lower-cased. If stripping would empty the prompt, the original is
 * kept.
 */
export function extractSagaDirectives(message: string): SagaDirectives {
    let readSaga:  string | null = null;
    let writeSaga: string | null = null;
    for (const match of message.matchAll(SAGA_DIRECTIVE)) {
        const kind = match[1].toLowerCase();
        const name = match[2].toLowerCase();
        const isRead  = kind === "read"  || kind === "saga";
        const isWrite = kind === "write" || kind === "saga";
        if (isRead  && readSaga  == null) { readSaga  = name; }
        if (isWrite && writeSaga == null) { writeSaga = name; }
    }
    const stripped = message.replace(SAGA_DIRECTIVE, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
    const prompt = stripped === "" ? message.trim() : stripped;
    return {readSaga, writeSaga, prompt};
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

    const {readSaga, writeSaga, prompt} = extractSagaDirectives(fields.message);

    return {issueNumber, repo, slackWebhookUrl, requester: fields.sender, memePrompt: prompt, channel: fields.channel, slackLink: fields.link, readSaga, writeSaga};
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

