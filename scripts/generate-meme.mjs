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
