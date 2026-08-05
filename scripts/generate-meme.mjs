#!/usr/bin/env node
// generate-meme.mjs — runs on GitHub Actions when an issue is opened.
// Generates a JPEG meme, commits it, closes the issue, and notifies Slack.

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

// ── Setup ────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MEMES_DIR = path.join(REPO_ROOT, "memes");

const {
  OPENAI_API_KEY, XAI_API_KEY,
  ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY,
  REPO, SLACK_WEBHOOK_URL,
} = process.env;

if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
if (!ISSUE_NUMBER)   { console.error("Missing ISSUE_NUMBER");   process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const xai    = XAI_API_KEY != null ? new OpenAI({ apiKey: XAI_API_KEY, baseURL: "https://api.x.ai/v1" }) : null;

const issueTitle = ISSUE_TITLE ?? "";
const requester  = ISSUE_BODY  ?? "unknown";
const outFile    = path.join(MEMES_DIR, `${ISSUE_NUMBER}.jpg`);
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

const twist = Math.random() < 0.4 ? RANDOM_TWISTS[Math.floor(Math.random() * RANDOM_TWISTS.length)] : null;
const prompt = `Make a meme: ${issueTitle}.${twist != null ? ` ${twist}` : ""}`.slice(0, 4000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function exec(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: REPO_ROOT });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postComment(body) {
  const tmp = `/tmp/gh-comment-${ISSUE_NUMBER}.txt`;
  fs.writeFileSync(tmp, body);
  exec(`gh issue comment ${ISSUE_NUMBER} --repo ${REPO} --body-file ${tmp}`);
  fs.unlinkSync(tmp);
}

function postSlack(data) {
  if (SLACK_WEBHOOK_URL == null) {
    console.log("No SLACK_WEBHOOK_URL — skipping Slack notification.");
    return;
  }
  const tmp = `/tmp/slack-payload-${ISSUE_NUMBER}.json`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  exec(`curl -s -X POST -H 'Content-Type: application/json' -d @${tmp} ${SLACK_WEBHOOK_URL}`);
  fs.unlinkSync(tmp);
}

function fail(message, closeIssue = false) {
  console.error("Failed:", message);
  postComment(`❌ Meme generation failed.\n\n\`\`\`\n${message}\n\`\`\``);
  if (closeIssue) {
    exec(`gh api repos/${REPO}/issues/${ISSUE_NUMBER} -X PATCH -f state=closed -f state_reason=not_planned`);
  }
  postSlack({ status: "failure", image_url: "", title: issueTitle, requester, error: message });
  process.exit(1);
}

function rateLimitDelayMs(err) {
  const retryAfter = err?.headers?.["retry-after"];
  if (retryAfter != null) { return (parseInt(retryAfter, 10) + 1) * 1000; }
  const match = (err?.message ?? "").match(/try again in (\d+(?:\.\d+)?)s/i);
  if (match != null) { return (parseFloat(match[1]) + 1) * 1000; }
  return null;
}

// ── Jitter ───────────────────────────────────────────────────────────────────

async function applyJitter() {
  const runsJson = exec(`gh api repos/${REPO}/actions/runs --jq '.workflow_runs | map(select(.status == "in_progress")) | length'`).trim();
  const concurrentRuns = Math.min(parseInt(runsJson, 10) || 1, 10);
  const jitterMs = concurrentRuns <= 1 ? 0 : Math.floor(Math.random() * concurrentRuns * 13_000);
  if (jitterMs > 0) {
    console.log(`${concurrentRuns} concurrent runs — waiting ${(jitterMs / 1000).toFixed(1)}s before first attempt…`);
    await sleep(jitterMs);
  }
}

// ── Image generation ─────────────────────────────────────────────────────────

async function generateWithOpenAI() {
  const MAX_RETRIES = 10;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await openai.images.generate({
        model: "gpt-image-2",
        prompt,
        size: "1536x1024",
        quality: "low",
        output_format: "jpeg",
      });
      const b64 = result.data?.[0]?.b64_json;
      if (b64 == null) { throw new Error("No image data returned from OpenAI."); }
      return Buffer.from(b64, "base64");
    } catch (err) {
      const isRateLimit       = err?.status === 429;
      const isModerationBlock = err?.error?.code === "moderation_blocked";
      const delayMs           = isRateLimit ? rateLimitDelayMs(err) : null;

      if (isRateLimit && delayMs != null && attempt < MAX_RETRIES) {
        console.log(`Rate limited — retrying in ${delayMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})…`);
        await sleep(delayMs);
        continue;
      }

      if (isModerationBlock) {
        const details = err?.error?.moderation_details;
        const extra = details != null
          ? `\nModeration stage: ${details.moderation_stage}\nCategories: ${(details.categories ?? []).join(", ")}`
          : "";
        throw Object.assign(new Error(err.message + extra), { isModerationBlock: true });
      }

      throw err;
    }
  }
}

async function generateWithXai() {
  const result = await xai.images.generate({ model: "grok-imagine-image-quality", prompt });
  const url = result.data?.[0]?.url;
  if (url == null) { throw new Error("xAI returned no image URL."); }
  exec(`curl -sL -o ${JSON.stringify(outFile)} ${JSON.stringify(url)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

fs.mkdirSync(MEMES_DIR, { recursive: true });

if (fs.existsSync(outFile)) {
  console.log(`memes/${ISSUE_NUMBER}.jpg already exists — skipping.`);
  process.exit(0);
}

console.log(`Generating meme for issue #${ISSUE_NUMBER}: ${issueTitle}`);
await applyJitter();

let imageProvider = "OpenAI";
const providerHistory = [];
const preferXai = xai != null && Math.random() < 0.5;

if (preferXai) {
  console.log("Randomly selected xAI as primary provider…");
  try {
    await generateWithXai();
    imageProvider = "xAI";
    providerHistory.push("xAI ✅");
  } catch (xaiErr) {
    console.log(`xAI failed (${xaiErr?.message}) — falling back to OpenAI…`);
    providerHistory.push(`xAI ❌ (${xaiErr?.message ?? String(xaiErr)})`);
  }
}

if (imageProvider === "OpenAI") {
  try {
    const imageBytes = await generateWithOpenAI();
    fs.writeFileSync(outFile, imageBytes);
    providerHistory.push("OpenAI ✅");
  } catch (err) {
    if (err.isModerationBlock === true && xai != null && !preferXai) {
      providerHistory.push(`OpenAI ❌ (moderation blocked)`);
      console.log("OpenAI moderation blocked — falling back to xAI…");
      try {
        await generateWithXai();
        imageProvider = "xAI";
        providerHistory.push("xAI ✅");
      } catch (xaiErr) {
        fail(`xAI fallback also failed: ${xaiErr?.message ?? String(xaiErr)}`);
      }
    } else {
      fail(err?.message ?? String(err), err.isModerationBlock === true);
    }
  }
}

console.log(`Saved: memes/${ISSUE_NUMBER}.jpg`);

exec(`git config user.name "github-actions[bot]"`);
exec(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
exec(`git add "memes/${ISSUE_NUMBER}.jpg"`);
exec(`git commit -m "Add meme for issue #${ISSUE_NUMBER}"`);

for (let attempt = 1; ; attempt++) {
  try {
    exec(`git pull --rebase origin main`);
    exec(`git push origin HEAD`);
    break;
  } catch {
    if (attempt >= 10) { fail("Failed to push after 10 attempts."); }
    console.log(`Push attempt ${attempt} failed — retrying…`);
  }
}

console.log("Pushed.");

const providerNote = twist != null ? ` _(${imageProvider} · ${twist})_` : ` _(${imageProvider})_`;
const successComment = [
  `🎉 Meme generated and committed to [memes/${ISSUE_NUMBER}.jpg](../blob/main/memes/${ISSUE_NUMBER}.jpg)${providerNote}`,
  ``,
  `**Prompt:** \`${prompt}\``,
  ``,
  `**Provider attempts:**`,
  ...providerHistory.map((entry) => `- ${entry}`),
].join("\n");
postComment(successComment);
exec(`gh api repos/${REPO}/issues/${ISSUE_NUMBER} -X PATCH -f state=closed`);
console.log(`Closed issue #${ISSUE_NUMBER}.`);

const imageUrl = `https://raw.githubusercontent.com/${REPO}/refs/heads/main/memes/${ISSUE_NUMBER}.jpg`;
postSlack({ status: "success", image_url: imageUrl, title: issueTitle, requester, error: "", provider: imageProvider });
console.log("Posted to Slack.");
