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

const { OPENAI_API_KEY, XAI_API_KEY, ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY, REPO, SLACK_WEBHOOK_URL } = process.env;

if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
if (!ISSUE_NUMBER)   { console.error("Missing ISSUE_NUMBER");   process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const xai = XAI_API_KEY != null ? new OpenAI({ apiKey: XAI_API_KEY, baseURL: "https://api.x.ai/v1" }) : null;

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
  exec(`gh api repos/${REPO}/issues/${ISSUE_NUMBER}/comments -X POST -f body=${JSON.stringify(body)}`);
}

function postSlack(data) {
  if (SLACK_WEBHOOK_URL == null) {
    console.log("No SLACK_WEBHOOK_URL set — skipping Slack notification.");
    return;
  }
  exec(`curl -s -X POST -H 'Content-Type: application/json' -d ${JSON.stringify(JSON.stringify(data))} ${SLACK_WEBHOOK_URL}`);
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
