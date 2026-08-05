#!/usr/bin/env node
// generate-meme.mjs
// Called by GitHub Actions on issue open.
// Reads issue context from env vars, generates a JPEG meme, commits + pushes, closes issue,
// and posts the result (or any error) directly to Slack.

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MEMES_DIR = path.join(REPO_ROOT, "memes");

const { OPENAI_API_KEY, ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY, REPO, SLACK_WEBHOOK_URL } = process.env;

if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
if (!ISSUE_NUMBER)   { console.error("Missing ISSUE_NUMBER");   process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function exec(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: REPO_ROOT });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(err) {
  // Honour the Retry-After header if present (value is in seconds)
  const retryAfterSec = err?.headers?.["retry-after"];
  if (retryAfterSec != null) {
    return (parseInt(retryAfterSec, 10) + 1) * 1000;
  }
  // Fall back to parsing "Please try again in Xs" from the error message
  const match = (err?.message ?? "").match(/try again in (\d+(?:\.\d+)?)s/i);
  if (match != null) {
    return (parseFloat(match[1]) + 1) * 1000;
  }
  return null;
}

function postComment(body) {
  const tmpFile = `/tmp/gh-comment-${ISSUE_NUMBER}.txt`;
  fs.writeFileSync(tmpFile, body);
  exec(`gh issue comment ${ISSUE_NUMBER} --repo ${REPO} --body-file ${tmpFile}`);
  fs.unlinkSync(tmpFile);
}

function postSlack(data) {
  if (SLACK_WEBHOOK_URL == null) {
    console.log("No SLACK_WEBHOOK_URL set — skipping Slack notification.");
    return;
  }
  const tmpFile = `/tmp/slack-payload-${ISSUE_NUMBER}.json`;
  fs.writeFileSync(tmpFile, JSON.stringify(data));
  exec(`curl -s -X POST -H 'Content-Type: application/json' -d @${tmpFile} ${SLACK_WEBHOOK_URL}`);
  fs.unlinkSync(tmpFile);
}

function failWithError(message, closeIssue = false) {
  console.error("Meme generation failed:", message);
  postComment(`❌ Meme generation failed.\n\n\`\`\`\n${message}\n\`\`\``);
  if (closeIssue) {
    exec(`gh api repos/${REPO}/issues/${ISSUE_NUMBER} -X PATCH -f state=closed -f state_reason=not_planned`);
  }
  postSlack({ status: "failure", image_url: "", title: issueTitle, requester, error: message });
  process.exit(1);
}

fs.mkdirSync(MEMES_DIR, { recursive: true });

const outFile = path.join(MEMES_DIR, `${ISSUE_NUMBER}.jpg`);
if (fs.existsSync(outFile)) {
  console.log(`memes/${ISSUE_NUMBER}.jpg already exists — skipping.`);
  process.exit(0);
}

const issueTitle = ISSUE_TITLE ?? "";
const requester = ISSUE_BODY ?? "unknown";
const prompt = `Make a meme. Favor existing meme-templates if you think that makes sense.
Actual context for the meme: ${issueTitle}.`.slice(0, 4000);

console.log(`Generating meme for issue #${ISSUE_NUMBER}: ${issueTitle}`);

// Scale jitter to the number of currently-running workflow jobs (capped at 10)
const runsJson = exec(`gh api repos/${REPO}/actions/runs --jq '.workflow_runs | map(select(.status == "in_progress")) | length'`).trim();
const concurrentRuns = Math.min(parseInt(runsJson, 10) || 1, 10);
const jitterMs = concurrentRuns <= 1 ? 0 : Math.floor(Math.random() * concurrentRuns * 13_000);
if (jitterMs > 0) {
  console.log(`${concurrentRuns} concurrent runs — waiting ${(jitterMs / 1000).toFixed(1)}s (jitter) before first attempt…`);
  await sleep(jitterMs);
}

const MAX_RETRIES = 10;
let result;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    result = await openai.images.generate({
      model: "gpt-image-2",
      prompt,
      size: "1536x1024",
      quality: "low",
      output_format: "jpeg",
    });
    break;
  } catch (err) {
    const isRateLimit = err?.status === 429;
    const delayMs = isRateLimit ? retryDelayMs(err) : null;

    if (isRateLimit && delayMs != null && attempt < MAX_RETRIES) {
      console.log(`Rate limited — waiting ${delayMs / 1000}s before retry (attempt ${attempt}/${MAX_RETRIES})…`);
      await sleep(delayMs);
      continue;
    }

    const isModerationBlock = err?.error?.code === "moderation_blocked";
    const details = err?.error?.moderation_details;
    const detailSuffix = details != null
      ? `\n\nModeration stage: ${details.moderation_stage}\nCategories: ${(details.categories ?? []).join(", ")}`
      : "";
    failWithError((err?.message ?? String(err)) + detailSuffix, isModerationBlock);
  }
}

const b64 = result.data?.[0]?.b64_json;
if (b64 == null) {
  failWithError("No image data returned from API.");
}

fs.writeFileSync(outFile, Buffer.from(b64, "base64"));
console.log(`Saved: memes/${ISSUE_NUMBER}.jpg`);

// Configure git identity for Actions
exec(`git config user.name "github-actions[bot]"`);
exec(`git config user.email "github-actions[bot]@users.noreply.github.com"`);

// Commit + push
exec(`git add "memes/${ISSUE_NUMBER}.jpg"`);
exec(`git commit -m "Add meme for issue #${ISSUE_NUMBER}"`);
let pushed = false;
for (let pushAttempt = 1; pushAttempt <= 5; pushAttempt++) {
  try {
    exec(`git pull --rebase origin HEAD`);
    exec(`git push origin HEAD`);
    pushed = true;
    break;
  } catch (pushErr) {
    if (pushAttempt < 5) {
      const pushJitter = Math.floor(Math.random() * 10_000) + 2_000;
      console.log(`Push failed, retrying in ${(pushJitter / 1000).toFixed(1)}s (attempt ${pushAttempt}/5)…`);
      await sleep(pushJitter);
    }
  }
}
if (!pushed) {
  failWithError("Failed to push after 5 attempts — another job may be conflicting.");
}
console.log(`Pushed.`);

// Comment + close issue
exec(`gh api repos/${REPO}/issues/${ISSUE_NUMBER}/comments -X POST -f body='🎉 Meme generated and committed to [memes/${ISSUE_NUMBER}.jpg](../blob/main/memes/${ISSUE_NUMBER}.jpg)'`);
exec(`gh api repos/${REPO}/issues/${ISSUE_NUMBER} -X PATCH -f state=closed`);
console.log(`Closed issue #${ISSUE_NUMBER}.`);

// Post meme to Slack
const imageUrl = `https://raw.githubusercontent.com/${REPO}/refs/heads/main/memes/${ISSUE_NUMBER}.jpg`;
postSlack({ status: "success", image_url: imageUrl, title: issueTitle, requester, error: "" });
console.log("Posted to Slack.");
