import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { Context, Duration, Effect, Either, Layer, Ref, Schedule } from "effect";
import { DoubleModerationError, EnvMissingError, ExecError, IssueBodyMissingFieldError, ModerationBlockedError, ProviderError, PushFailedError, RateLimitExhaustedError } from "./errors.js";

const MODERATION_FALLBACK    = "xAI";
const MAX_RETRIES            = 10;
const MAX_PUSH_RETRIES       = 5;
const RETRY_DELAY_PADDING_MS = 1_000;

interface ProviderConfig {
  name:     string;
  envKey:   string;
  model:    string;
  baseURL?: string;
  params?:  Record<string, string>;
}

const PROVIDER_CONFIGS: ProviderConfig[] = [
  { name: "OpenAI", envKey: "OPENAI_API_KEY", model: "gpt-image-2",        params: { size: "1024x1024", quality: "low" } },
  { name: "xAI",    envKey: "XAI_API_KEY",    model: "grok-imagine-image",  baseURL: "https://api.x.ai/v1" },
];

const RANDOM_TWISTS = [
  "Make it extremely dramatic.",
  "Use a medieval art style.",
  "Set it in space.",
  "Make it look like a warning label.",
  "Draw it as a motivational poster.",
  "Make it a Renaissance painting.",
  "Give it an 80s action movie vibe.",
  "Make it look like a government document.",
  "Use pixel art style.",
  "Make it extremely passive-aggressive.",
  "Set it in the 1950s.",
  "Make it look like a children's book illustration.",
];

if (!PROVIDER_CONFIGS.some((c) => c.name === MODERATION_FALLBACK)) {
  console.error(`MODERATION_FALLBACK "${MODERATION_FALLBACK}" does not match any provider in PROVIDER_CONFIGS.`);
  process.exit(1);
}

interface Config {
  issueNumber:     string;
  repo:            string;
  slackWebhookUrl: string;
  requester:       string;
  memePrompt:      string;
  channel:         string;
  slackLink:       string;
  providerApiKeys: Record<string, string>;
}

class ConfigService extends Context.Tag("ConfigService")<ConfigService, Config>() {}

type ProviderFn = (prompt: string) => Effect.Effect<{ buffer: Buffer; rateLimitHits: number }, ModerationBlockedError | RateLimitExhaustedError | ProviderError>;

class ExecService extends Context.Tag("ExecService")<ExecService, (cmd: string) => Effect.Effect<string, ExecError>>() {}
class ProvidersService extends Context.Tag("ProvidersService")<ProvidersService, Record<string, ProviderFn>>() {}

interface HistoryEntry {
  provider: string;
  status:   "success" | "rate-limited" | "failed";
  message?: string;
}

interface SuccessCommentParams {
  memeId:    string;
  provider:  string;
  history:   HistoryEntry[];
  prompt:    string;
  twist:     string | null;
  requester: string;
  channel:   string;
  slackLink: string;
}

interface SlackPayload {
  status:    "success" | "failure";
  image_url: string;
  title:     string;
  requester: string;
  error:     string;
  provider?: string;
}

// OpenAI error shape for catch-clause narrowing
interface ApiError {
  status?:  number;
  message?: string;
  headers?: Record<string, string>;
  error?: {
    code?:                string;
    moderation_details?: {
      moderation_stage: string;
      categories?:      string[];
    };
  };
}

function buildConfig(): Effect.Effect<Config, EnvMissingError | IssueBodyMissingFieldError> {
  return Effect.gen(function* () {
    const readEnvVar = (key: string): Effect.Effect<string, EnvMissingError> => {
      const val = process.env[key];
      return val != null ? Effect.succeed(val) : Effect.fail(new EnvMissingError(key));
    };

    const providerApiKeys = yield* Effect.all(
      Object.fromEntries(PROVIDER_CONFIGS.map(({ envKey }) => [envKey, readEnvVar(envKey)])),
    );
    const issueNumber = yield* readEnvVar("ISSUE_NUMBER");
    const issueBody   = yield* readEnvVar("ISSUE_BODY");
    const repo        = yield* readEnvVar("REPO");
    const slackUrl    = yield* readEnvVar("SLACK_WEBHOOK_URL");

    const fields       = parseIssueBody(issueBody);
    const requireField = (key: string, label: string): Effect.Effect<string, IssueBodyMissingFieldError> =>
      fields[key] != null ? Effect.succeed(fields[key]) : Effect.fail(new IssueBodyMissingFieldError(label));

    const requester  = yield* requireField("sender",  "Sender");
    const memePrompt = yield* requireField("message", "Message");
    const channel    = yield* requireField("channel", "Channel");
    const slackLink  = yield* requireField("link",    "Link");

    return { issueNumber, repo, slackWebhookUrl: slackUrl, requester, memePrompt, channel, slackLink, providerApiKeys };
  });
}

const ConfigLayer = Layer.effect(ConfigService, buildConfig());

const ExecLayer = Layer.sync(ExecService, () => {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return (cmd: string) => Effect.try({
    try:   () => execSync(cmd, { encoding: "utf8", cwd: repoRoot }),
    catch: (e) => new ExecError(cmd, String(e)),
  });
});

const ProvidersLayer = Layer.effect(
  ProvidersService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    return Object.fromEntries(
      PROVIDER_CONFIGS.map(({ name, envKey, model, baseURL, params }) => {
        const client = new OpenAI({ apiKey: config.providerApiKeys[envKey], ...(baseURL != null ? { baseURL } : {}) });
        return [name, (prompt: string) => callWithRetry(client, model, params ?? {}, prompt)];
      }),
    );
  }),
);

function parseIssueBody(body: string): Record<string, string> {
  // Only lines whose left-hand side matches a known field name start a new field;
  // all other lines append to the current value, preserving multi-line Slack messages.
  const knownFields = new Set(["sender", "message", "channel", "link"]);
  const result: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const rawLine of (body ?? "").split("\n")) {
    const line         = rawLine.replace(/\r$/, "");
    const sep          = line.indexOf(": ");
    const potentialKey = sep !== -1 ? line.slice(0, sep).trim().toLowerCase() : null;

    if (potentialKey != null && knownFields.has(potentialKey)) {
      currentKey         = potentialKey;
      result[currentKey] = line.slice(sep + 2).trim();
    } else if (currentKey != null && line.trim() !== "") {
      result[currentKey] += "\n" + line;
    }
  }

  return result;
}

// Internal: a 429 where we successfully parsed the retry delay.
// Not exported — only meaningful within callWithRetry.
class RateLimitRetryableError {
  readonly _tag = "RateLimitRetryableError";
  constructor(readonly delayMs: number) {}
}

type CallError = ModerationBlockedError | RateLimitRetryableError | ProviderError;

function classifyApiError(err: unknown, model: string): CallError {
  const apiErr = err as ApiError;

  if (apiErr?.error?.code === "moderation_blocked") {
    const details = apiErr?.error?.moderation_details;
    const extra   = details != null
      ? `\nModeration stage: ${details.moderation_stage}\nCategories: ${(details.categories ?? []).join(", ")}`
      : "";
    return new ModerationBlockedError(model, (apiErr?.message ?? String(err)) + extra);
  }

  if (apiErr?.status === 429) {
    const delayMs = parseRetryDelayMs(apiErr);
    if (delayMs != null) { return new RateLimitRetryableError(delayMs); }
    console.warn(`Rate limited but could not parse retry delay - giving up.`);
  }

  return new ProviderError(model, apiErr?.message ?? String(err));
}

function callWithRetry(
  client: OpenAI,
  model: string,
  params: Record<string, string>,
  prompt: string,
): Effect.Effect<{ buffer: Buffer; rateLimitHits: number }, ModerationBlockedError | RateLimitExhaustedError | ProviderError> {
  return Effect.gen(function* () {
    const rateLimitHitsRef = yield* Ref.make(0);

    // A single attempt: call the API and classify any thrown error into a typed failure.
    // tapError runs the side effect (log + sleep) before Effect.retry re-runs the attempt.
    const attempt = Effect.tryPromise({
      try:   () => client.images.generate({ model, prompt, response_format: "b64_json", ...params }),
      catch: (err) => classifyApiError(err, model),
    }).pipe(
      Effect.flatMap((result) => {
        const b64 = result.data?.[0]?.b64_json;
        if (b64 == null) { return Effect.fail(new ProviderError(model, "No image data returned")); }
        return Effect.succeed(Buffer.from(b64, "base64"));
      }),
      Effect.tapError((e) => {
        if (e._tag !== "RateLimitRetryableError") { return Effect.void; }
        return Effect.gen(function* () {
          const hits = yield* Ref.updateAndGet(rateLimitHitsRef, (n) => n + 1);
          console.log(`Rate limited - retrying in ${e.delayMs / 1000}s (attempt ${hits}/${MAX_RETRIES})...`);
          yield* Effect.sleep(Duration.millis(e.delayMs));
        });
      }),
    );

    // Only retry RateLimitRetryableError — let ModerationBlockedError and ProviderError pass through immediately.
    const retryPolicy = Schedule.recurWhile((e: CallError) => e._tag === "RateLimitRetryableError").pipe(
      Schedule.intersect(Schedule.recurs(MAX_RETRIES - 1)),
    );

    // After retries are exhausted, the final error is still RateLimitRetryableError — promote it.
    const buffer = yield* Effect.retry(attempt, retryPolicy).pipe(
      Effect.mapError((e) => e._tag === "RateLimitRetryableError" ? new RateLimitExhaustedError(model, MAX_RETRIES) : e),
    );

    const rateLimitHits = yield* Ref.get(rateLimitHitsRef);
    return { buffer, rateLimitHits };
  });
}

function parseRetryDelayMs(err: ApiError): number | null {
  const fromHeader = parseInt(err?.headers?.["retry-after"] ?? "", 10);
  if (!isNaN(fromHeader)) { return fromHeader * 1000 + RETRY_DELAY_PADDING_MS; }

  const match = (err?.message ?? "").match(/try again in (\d+(?:\.\d+)?)s/i);
  return match != null ? parseFloat(match[1]) * 1000 + RETRY_DELAY_PADDING_MS : null;
}

function pickRandomTwist(): string | null {
  return Math.random() < 0.4 ? RANDOM_TWISTS[Math.floor(Math.random() * RANDOM_TWISTS.length)] : null;
}

function waitForJitter(): Effect.Effect<void, never, ExecService | ConfigService> {
  return Effect.gen(function* () {
    const exec   = yield* ExecService;
    const config = yield* ConfigService;
    const runsJson = yield* exec(`gh api repos/${config.repo}/actions/runs --jq '.workflow_runs | map(select(.status == "in_progress")) | length'`).pipe(
      Effect.map((s) => s.trim()),
      Effect.catchAll(() => Effect.succeed("1")),
    );
    const concurrentRuns = Math.min(isNaN(parseInt(runsJson, 10)) ? 1 : parseInt(runsJson, 10), 10);
    const jitterMs       = concurrentRuns <= 1 ? 0 : Math.floor(Math.random() * concurrentRuns * 13_000);
    if (jitterMs > 0) {
      yield* Effect.log(`${concurrentRuns} concurrent runs - waiting ${(jitterMs / 1000).toFixed(1)}s before first attempt...`);
      yield* Effect.sleep(Duration.millis(jitterMs));
    }
  });
}

function generateImage(prompt: string): Effect.Effect<{ buffer: Buffer; history: HistoryEntry[] }, ProviderError | RateLimitExhaustedError | DoubleModerationError, ProvidersService> {
  return Effect.gen(function* () {
    const providers  = yield* ProvidersService;
    const candidates = PROVIDER_CONFIGS.map((c) => c.name).filter((n) => n !== MODERATION_FALLBACK);
    const primary    = candidates[Math.floor(Math.random() * candidates.length)];
    yield* Effect.log(`Randomly selected ${primary} as primary provider...`);

    const primaryResult = yield* providers[primary](prompt).pipe(Effect.either);
    if (Either.isRight(primaryResult)) {
      const { buffer, rateLimitHits } = primaryResult.right;
      return {
        buffer,
        history: [
          ...Array.from({ length: rateLimitHits }, (): HistoryEntry => ({ provider: primary, status: "rate-limited" })),
          { provider: primary, status: "success" as const },
        ],
      };
    }

    const primaryErr = primaryResult.left;
    if (primaryErr._tag !== "ModerationBlockedError") {
      return yield* Effect.fail(primaryErr);
    }

    yield* Effect.log(`Moderation block - falling back to ${MODERATION_FALLBACK}...`);
    const primaryEntry: HistoryEntry = { provider: primary, status: "failed", message: primaryErr.message };

    const fallbackResult = yield* providers[MODERATION_FALLBACK](prompt).pipe(Effect.either);
    if (Either.isRight(fallbackResult)) {
      const { buffer, rateLimitHits } = fallbackResult.right;
      return {
        buffer,
        history: [
          primaryEntry,
          ...Array.from({ length: rateLimitHits }, (): HistoryEntry => ({ provider: MODERATION_FALLBACK, status: "rate-limited" })),
          { provider: MODERATION_FALLBACK, status: "success" as const },
        ],
      };
    }

    return yield* Effect.fail(new DoubleModerationError(MODERATION_FALLBACK));
  });
}

function postComment(body: string): Effect.Effect<void, never, ExecService | ConfigService> {
  return Effect.gen(function* () {
    const exec   = yield* ExecService;
    const config = yield* ConfigService;
    const tmp    = path.join(os.tmpdir(), `gh-comment-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmp, body);
    try {
      yield* exec(`gh issue comment ${config.issueNumber} --repo ${config.repo} --body-file ${tmp}`).pipe(Effect.catchAll(() => Effect.void));
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  });
}

function postSlack(data: SlackPayload): Effect.Effect<void, never, ExecService | ConfigService> {
  return Effect.gen(function* () {
    const exec   = yield* ExecService;
    const config = yield* ConfigService;
    const tmp    = path.join(os.tmpdir(), `slack-payload-${crypto.randomUUID()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(data));
    try {
      yield* exec(`curl -s -X POST -H 'Content-Type: application/json' -d @${tmp} '${config.slackWebhookUrl}'`).pipe(Effect.catchAll(() => Effect.void));
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  });
}

// Internal: a single failed push attempt — used only within commitAndPush retry loop
class PushAttemptError { readonly _tag = "PushAttemptError" as const; }

function commitAndPush(memeId: string): Effect.Effect<void, PushFailedError, ExecService | ConfigService> {
  return Effect.gen(function* () {
    const exec   = yield* ExecService;
    const config = yield* ConfigService;

    yield* exec(`git config user.name "github-actions[bot]"`).pipe(Effect.mapError(() => new PushFailedError(0)));
    yield* exec(`git config user.email "github-actions[bot]@users.noreply.github.com"`).pipe(Effect.mapError(() => new PushFailedError(0)));
    yield* exec(`git add "memes/${memeId}.jpg"`).pipe(Effect.mapError(() => new PushFailedError(0)));
    yield* exec(`git commit -m "Add meme for issue #${config.issueNumber} (${memeId})"`).pipe(Effect.mapError(() => new PushFailedError(0)));
    yield* Effect.log(`Committed memes/${memeId}.jpg`);

    const pushAttempt = exec(`git pull --rebase origin main`).pipe(
      Effect.flatMap(() => exec(`git push origin HEAD`)),
      Effect.mapError(() => new PushAttemptError()),
    );

    yield* Effect.retry(
      pushAttempt.pipe(Effect.tapError(() => Effect.log("Push failed - retrying..."))),
      Schedule.recurs(MAX_PUSH_RETRIES - 1),
    ).pipe(
      Effect.tap(() => Effect.log(`Pushed memes/${memeId}.jpg`)),
      Effect.mapError(() => new PushFailedError(MAX_PUSH_RETRIES)),
    );
  });
}

function notifySuccess({ memeId, history, prompt, twist }: { memeId: string; history: HistoryEntry[]; prompt: string; twist: string | null }): Effect.Effect<void, never, ExecService | ConfigService> {
  return Effect.gen(function* () {
    const config   = yield* ConfigService;
    const provider = history.find((e) => e.status === "success")?.provider ?? "unknown";
    const params   = { memeId, provider, history, prompt, twist, requester: config.requester, channel: config.channel, slackLink: config.slackLink };
    yield* postComment(buildSuccessComment(params)).pipe(Effect.catchAll(() => Effect.void));
    yield* (yield* ExecService)(`gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed`).pipe(Effect.catchAll(() => Effect.void));
    yield* Effect.log(`Issue #${config.issueNumber} closed.`);
    const imageUrl = `https://raw.githubusercontent.com/${config.repo}/refs/heads/main/memes/${memeId}.jpg`;
    yield* postSlack({ status: "success", image_url: imageUrl, title: config.memePrompt, requester: config.requester, error: "", provider }).pipe(Effect.catchAll(() => Effect.void));
  });
}

function buildSuccessComment({ memeId, provider, history, prompt, twist, requester, channel, slackLink }: SuccessCommentParams): string {
  const providerNote  = ` _(${[provider, twist].filter((x) => x != null).join(" - ")})_`;
  const promptDisplay = prompt.includes("`") ? `\`\`${prompt}\`\`` : `\`${prompt}\``;
  return [
    `🎉 Meme generated and committed to [memes/${memeId}.jpg](../blob/main/memes/${memeId}.jpg)${providerNote}`,
    ``,
    `**Requested by:** ${requester} in ${channel} - [View in Slack](${slackLink})`,
    `**Prompt:** ${promptDisplay}`,
    ``,
    `**Provider attempts:**`,
    ...history.map(({ provider, status, message }) => {
      switch (status) {
        case "success":      return `- ${provider} ✅`;
        case "rate-limited": return `- ${provider} ⏳ rate limited`;
        default:             return `- ${provider} ❌ (${message})`;
      }
    }),
  ].join("\n");
}

const program = Effect.gen(function* () {
  const config = yield* ConfigService;

  yield* Effect.gen(function* () {
    const repoRoot   = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const memesDir   = path.join(repoRoot, "memes");
    const memeId   = crypto.randomUUID();
    const outFile  = path.join(memesDir, `${memeId}.jpg`);
    const twist    = pickRandomTwist();
    const fullPrompt = `Make a meme: ${config.memePrompt}.${twist != null ? ` ${twist}` : ""}`;
    if (fullPrompt.length > 4000) { yield* Effect.logWarning(`Prompt truncated from ${fullPrompt.length} to 4000 characters.`); }
    const prompt = fullPrompt.slice(0, 4000);
    yield* Effect.sync(() => fs.mkdirSync(memesDir, { recursive: true }));

    yield* Effect.log(`Starting generation for issue #${config.issueNumber}: "${config.memePrompt}"`);
    yield* waitForJitter();
    const { buffer, history } = yield* generateImage(prompt);
    yield* Effect.sync(() => fs.writeFileSync(outFile, buffer));
    yield* Effect.log(`Image saved: ${outFile}`);
    yield* commitAndPush(memeId);
    yield* notifySuccess({ memeId, history, prompt, twist });
    yield* Effect.log("Done.");
  }).pipe(
    Effect.catchAll((e) => Effect.gen(function* () {
      yield* Effect.logError(`Fatal: ${e.message}`);
      yield* postComment(`❌ Meme generation failed.\n\n\`\`\`\n${e.message}\n\`\`\``).pipe(Effect.catchAll(() => Effect.void));
      yield* postSlack({ status: "failure", image_url: "", title: config.memePrompt, requester: config.requester, error: e.message }).pipe(Effect.catchAll(() => Effect.void));
      if (e._tag === "DoubleModerationError") {
        const exec = yield* ExecService;
        yield* exec(`gh api repos/${config.repo}/issues/${config.issueNumber} -X PATCH -f state=closed -f state_reason=not_planned`).pipe(Effect.catchAll(() => Effect.void));
      }
      // Die (not fail) so the outer tapError doesn't double-log this
      return yield* Effect.die("failure-handled");
    })),
  );
});

const AppLayer = Layer.mergeAll(
  ConfigLayer,
  ExecLayer,
  ProvidersLayer.pipe(Layer.provide(ConfigLayer)),
);

Effect.runPromise(
  Effect.provide(program, AppLayer).pipe(
    // Config errors (EnvMissingError, IssueBodyMissingFieldError) are typed failures
    // that escape the inner catchAll — log them before exiting
    Effect.tapError((e) => Effect.logError(e.message)),
  ),
).catch(() => process.exit(1));
