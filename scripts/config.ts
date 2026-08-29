import * as ConfigError from "effect/ConfigError";
import {Config, Context, Effect, Layer, Schema} from "effect";
import {parseSagaDirectives} from "./saga-directives.js";

export interface AppConfig {
    readonly issueNumber: string;
    readonly repo: string;
    readonly slackWebhookUrl: string;
    readonly requester: string;
    readonly memePrompt: string;
    readonly channel: string;
    readonly slackLink: string;
    readonly readSaga: string | null;
    readonly writeSaga: string | null;
}

export class AppConfigService extends Context.Tag("AppConfigService")<AppConfigService, AppConfig>() {}

const loadAppConfig = Effect.gen(function* () {
    const env = yield* Config.all({
        repo: Config.string("REPO"),
        slackWebhookUrl: Config.string("SLACK_WEBHOOK_URL"),
        issueNumber: Config.string("ISSUE_NUMBER"),
        issueBody: Config.string("ISSUE_BODY"),
    });
    const fields = yield* parseIssueBody(env.issueBody).pipe(
        Effect.mapError((error) =>
            ConfigError.InvalidData(["ISSUE_BODY"], error.message)),
    );
    const directives = parseSagaDirectives(fields.message);

    return {
        issueNumber: env.issueNumber,
        repo: env.repo,
        slackWebhookUrl: env.slackWebhookUrl,
        requester: fields.sender,
        memePrompt: directives.prompt,
        channel: fields.channel,
        slackLink: fields.link,
        readSaga: directives.readSaga,
        writeSaga: directives.writeSaga,
    } satisfies AppConfig;
});

export const AppConfigLayer = Layer.effect(AppConfigService, loadAppConfig);

export const parseIssueBody = (body: string) =>
    Schema.decodeUnknown(IssueFields)(tokenizeIssueBody(body));

export class IssueFields extends Schema.Class<IssueFields>("IssueFields")({
    sender: Schema.NonEmptyTrimmedString,
    message: Schema.NonEmptyTrimmedString,
    channel: Schema.NonEmptyTrimmedString,
    link: Schema.NonEmptyTrimmedString,
}) {}

// Keys emitted by the Slack workflow that files these issues. Only these start a
// new field; any other line is treated as a continuation of the current value so
// that multi-line messages (which may themselves contain "word: ..." lines, e.g.
// "Rune: :sadpepe:") are preserved instead of being truncated at the first line.
const KNOWN_KEYS = new Set(["sender", "channel", "message", "link", "timestamp"]);

interface TokenizerState {
    readonly fields: Readonly<Record<string, string>>;
    readonly currentKey: string | null;
}

function tokenizeIssueBody(body: string): Readonly<Record<string, string>> {
    const initial: TokenizerState = {fields: {}, currentKey: null};

    return body.split("\n").reduce<TokenizerState>((state, rawLine) => {
        const line = rawLine.replace(/\r$/, "");
        const separator = line.indexOf(": ");
        const potentialKey = separator === -1
            ? null
            : line.slice(0, separator).trim().toLowerCase();

        if (potentialKey != null && KNOWN_KEYS.has(potentialKey)) {
            return {
                currentKey: potentialKey,
                fields: {
                    ...state.fields,
                    [potentialKey]: line.slice(separator + 2).trim(),
                },
            };
        }

        if (state.currentKey == null || line.trim() === "") {
            return state;
        }

        return {
            ...state,
            fields: {
                ...state.fields,
                [state.currentKey]: `${state.fields[state.currentKey]}\n${line}`,
            },
        };
    }, initial).fields;
}
