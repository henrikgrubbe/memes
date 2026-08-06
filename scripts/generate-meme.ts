import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { Context, Duration, Effect, Layer, Ref, Schedule } from "effect";
import { DoubleModerationError, EnvMissingError, IssueBodyMissingFieldError, ModerationBlockedError, ProviderError, PushFailedError, RateLimitExhaustedError } from "./errors.js";

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

class ModerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModerationError";
  }
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

type Exec      = (cmd: string) => string;
type Providers = Record<string, (prompt: string) => Promise<{ buffer: Buffer; rateLimitHits: number }>>;

interface Ctx {
  issueNumber:     string;
  repo:            string;
  slackWebhookUrl: string;
  requester:       string;
  memePrompt:      string;
  channel:         string;
  slackLink:       string;
  exec:            Exec;
  providers:       Providers;
}

interface HistoryEntry {
  provider: string;
  status:   "success" | "rate-limited" | "failed";
  message?: string;
}

type ProviderResult =
  | { ok: true;  buffer: Buffer; entries: HistoryEntry[] }
  | { ok: false; isModeration: boolean; buffer: null; entries: HistoryEntry[] };

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

function computeRepoRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function makeExec(repoRoot: string): Exec {
  return (cmd) => execSync(cmd, { encoding: "utf8", cwd: repoRoot });
}

function buildCtx(config: Config, exec: Exec): Ctx {
  return {
    issueNumber:     config.issueNumber,
    repo:            config.repo,
    slackWebhookUrl: config.slackWebhookUrl,
    requester:       config.requester,
    memePrompt:      config.memePrompt,
    channel:         config.channel,
    slackLink:       config.slackLink,
    exec,
    providers:       buildProviders(config.providerApiKeys),
  };
}

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

function buildProviders(apiKeys: Record<string, string>): Providers {
  return Object.fromEntries(
    PROVIDER_CONFIGS.map(({ name, envKey, model, baseURL, params }) => {
      const client = new OpenAI({ apiKey: apiKeys[envKey], ...(baseURL != null ? { baseURL } : {}) });
      return [name, (prompt: string) => Effect.runPromise(callWithRetry(client, model, params ?? {}, prompt))];
    }),
  );
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

function waitForJitter(ctx: Ctx): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const runsJson = yield* Effect.sync(() => {
      try { return ctx.exec(`gh api repos/${ctx.repo}/actions/runs --jq '.workflow_runs | map(select(.status == "in_progress")) | length'`).trim(); }
      catch { return "1"; }
    });
    const concurrentRuns = Math.min(isNaN(parseInt(runsJson, 10)) ? 1 : parseInt(runsJson, 10), 10);
    const jitterMs       = concurrentRuns <= 1 ? 0 : Math.floor(Math.random() * concurrentRuns * 13_000);
    if (jitterMs > 0) {
      yield* Effect.log(`${concurrentRuns} concurrent runs - waiting ${(jitterMs / 1000).toFixed(1)}s before first attempt...`);
      yield* Effect.sleep(Duration.millis(jitterMs));
    }
  });
}

function generateImage(ctx: Ctx, prompt: string): Effect.Effect<{ buffer: Buffer; history: HistoryEntry[] }, ProviderError | RateLimitExhaustedError | DoubleModerationError> {
  return Effect.gen(function* () {
    const candidates = PROVIDER_CONFIGS.map((c) => c.name).filter((n) => n !== MODERATION_FALLBACK);
    const primary    = candidates[Math.floor(Math.random() * candidates.length)];
    yield* Effect.log(`Randomly selected ${primary} as primary provider...`);

    const primaryResult = yield* Effect.promise(() => tryProvider(ctx, primary, prompt));
    if (primaryResult.ok) {
      return { buffer: primaryResult.buffer, history: primaryResult.entries };
    }
    if (!primaryResult.isModeration) {
      return yield* Effect.fail(new ProviderError(primary, `${primary} failed`));
    }

    yield* Effect.log(`Moderation block - falling back to ${MODERATION_FALLBACK}...`);
    const fallbackResult = yield* Effect.promise(() => tryProvider(ctx, MODERATION_FALLBACK, prompt));
    if (!fallbackResult.ok) {
      return yield* Effect.fail(new DoubleModerationError(MODERATION_FALLBACK));
    }

    return { buffer: fallbackResult.buffer, history: [...primaryResult.entries, ...fallbackResult.entries] };
  });
}

async function tryProvider(ctx: Ctx, name: string, prompt: string): Promise<ProviderResult> {
  return ctx.providers[name](prompt)
    .then(({ buffer, rateLimitHits }) => ({
      ok:      true as const,
      buffer,
      entries: [
        ...Array.from({ length: rateLimitHits }, (): HistoryEntry => ({ provider: name, status: "rate-limited" })),
        { provider: name, status: "success" as const },
      ],
    }))
    .catch((err: unknown) => ({
      ok:           false as const,
      isModeration: err instanceof ModerationError || (err != null && typeof err === "object" && "_tag" in err && (err as { _tag: string })._tag === "ModerationBlockedError"),
      buffer:       null,
      entries:      [{ provider: name, status: "failed" as const, message: (err != null && typeof err === "object" && "message" in err) ? String((err as { message: unknown }).message) : String(err) }],
    }));
}

function withTmpFile(tmpPath: string, content: string, fn: () => void) {
  fs.writeFileSync(tmpPath, content);
  try { fn(); } finally { fs.unlinkSync(tmpPath); }
}

function postComment(ctx: Ctx, body: string) {
  const tmp = path.join(os.tmpdir(), `gh-comment-${crypto.randomUUID()}.txt`);
  withTmpFile(tmp, body, () => ctx.exec(`gh issue comment ${ctx.issueNumber} --repo ${ctx.repo} --body-file ${tmp}`));
}

function postSlack(ctx: Ctx, data: SlackPayload) {
  const tmp = path.join(os.tmpdir(), `slack-payload-${crypto.randomUUID()}.json`);
  withTmpFile(tmp, JSON.stringify(data), () => ctx.exec(`curl -s -X POST -H 'Content-Type: application/json' -d @${tmp} '${ctx.slackWebhookUrl}'`));
}

// Internal: a single failed push attempt — used only within commitAndPush retry loop
class PushAttemptError { readonly _tag = "PushAttemptError" as const; }

function commitAndPush(ctx: Ctx, memeId: string): Effect.Effect<void, PushFailedError> {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        ctx.exec(`git config user.name "github-actions[bot]"`);
        ctx.exec(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
        ctx.exec(`git add "memes/${memeId}.jpg"`);
        ctx.exec(`git commit -m "Add meme for issue #${ctx.issueNumber} (${memeId})"`);
      },
      catch: () => new PushFailedError(0),
    });
    yield* Effect.log(`Committed memes/${memeId}.jpg`);

    const pushAttempt = Effect.try({
      try:   () => { ctx.exec(`git pull --rebase origin main`); ctx.exec(`git push origin HEAD`); },
      catch: () => new PushAttemptError(),
    });

    yield* Effect.retry(
      pushAttempt.pipe(Effect.tapError(() => Effect.log("Push failed - retrying..."))),
      Schedule.recurs(MAX_PUSH_RETRIES - 1),
    ).pipe(
      Effect.tap(() => Effect.log(`Pushed memes/${memeId}.jpg`)),
      Effect.mapError(() => new PushFailedError(MAX_PUSH_RETRIES)),
    );
  });
}

function notifySuccess(ctx: Ctx, { memeId, history, prompt, twist }: { memeId: string; history: HistoryEntry[]; prompt: string; twist: string | null }): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const provider = history.find((e) => e.status === "success")?.provider ?? "unknown";
    const params   = { memeId, provider, history, prompt, twist, requester: ctx.requester, channel: ctx.channel, slackLink: ctx.slackLink };
    yield* Effect.sync(() => { try { postComment(ctx, buildSuccessComment(params)); } catch {} });
    yield* Effect.sync(() => { try { ctx.exec(`gh api repos/${ctx.repo}/issues/${ctx.issueNumber} -X PATCH -f state=closed`); } catch {} });
    yield* Effect.log(`Issue #${ctx.issueNumber} closed.`);
    const imageUrl = `https://raw.githubusercontent.com/${ctx.repo}/refs/heads/main/memes/${memeId}.jpg`;
    yield* Effect.sync(() => { try { postSlack(ctx, { status: "success", image_url: imageUrl, title: ctx.memePrompt, requester: ctx.requester, error: "", provider }); } catch {} });
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
  const config   = yield* ConfigService;
  const repoRoot = computeRepoRoot();
  const exec     = makeExec(repoRoot);
  const ctx      = buildCtx(config, exec);

  yield* Effect.gen(function* () {
    const memesDir = path.join(repoRoot, "memes");
    const memeId   = crypto.randomUUID();
    const outFile  = path.join(memesDir, `${memeId}.jpg`);
    const twist    = pickRandomTwist();
    const fullPrompt = `Make a meme: ${ctx.memePrompt}.${twist != null ? ` ${twist}` : ""}`;
    if (fullPrompt.length > 4000) { yield* Effect.logWarning(`Prompt truncated from ${fullPrompt.length} to 4000 characters.`); }
    const prompt = fullPrompt.slice(0, 4000);
    yield* Effect.sync(() => fs.mkdirSync(memesDir, { recursive: true }));

    yield* Effect.log(`Starting generation for issue #${ctx.issueNumber}: "${ctx.memePrompt}"`);
    yield* waitForJitter(ctx);
    const { buffer, history } = yield* generateImage(ctx, prompt);
    yield* Effect.sync(() => fs.writeFileSync(outFile, buffer));
    yield* Effect.log(`Image saved: ${outFile}`);
    yield* commitAndPush(ctx, memeId);
    yield* notifySuccess(ctx, { memeId, history, prompt, twist });
    yield* Effect.log("Done.");
  }).pipe(
    Effect.catchAll((e) => Effect.gen(function* () {
      yield* Effect.logError(`Fatal: ${e.message}`);
      yield* Effect.sync(() => {
        try {
          postComment(ctx, `❌ Meme generation failed.\n\n\`\`\`\n${e.message}\n\`\`\``);
          postSlack(ctx, { status: "failure", image_url: "", title: ctx.memePrompt, requester: ctx.requester, error: e.message });
        } catch { /* notification failure must not hide the real error */ }
        try {
          if (e._tag === "DoubleModerationError") {
            ctx.exec(`gh api repos/${ctx.repo}/issues/${ctx.issueNumber} -X PATCH -f state=closed -f state_reason=not_planned`);
          }
        } catch {}
      });
      // Die (not fail) so the outer tapError doesn't double-log this
      return yield* Effect.die("failure-handled");
    })),
  );
});

const AppLayer = ConfigLayer;

Effect.runPromise(
  Effect.provide(program, AppLayer).pipe(
    // Config errors (EnvMissingError, IssueBodyMissingFieldError) are typed failures
    // that escape the inner catchAll — log them before exiting
    Effect.tapError((e) => Effect.logError(e.message)),
  ),
).catch(() => process.exit(1));
