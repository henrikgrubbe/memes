#!/usr/bin/env node
// generate-meme.mjs
// Called by GitHub Actions on issue open.
// Reads issue context from env vars, generates a JPEG meme, commits + pushes, closes issue.

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MEMES_DIR = path.join(REPO_ROOT, "memes");

const { OPENAI_API_KEY, ISSUE_NUMBER, ISSUE_TITLE, REPO } = process.env;

if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
if (!ISSUE_NUMBER)   { console.error("Missing ISSUE_NUMBER");   process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function exec(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: REPO_ROOT });
}

fs.mkdirSync(MEMES_DIR, { recursive: true });

const outFile = path.join(MEMES_DIR, `${ISSUE_NUMBER}.jpg`);
if (fs.existsSync(outFile)) {
  console.log(`memes/${ISSUE_NUMBER}.jpg already exists — skipping.`);
  process.exit(0);
}
function postComment(body) {
  exec(`gh api repos/${REPO}/issues/${ISSUE_NUMBER}/comments -X POST -f body=${JSON.stringify(body)}`);
}

const issueTitle = ISSUE_TITLE ?? "";
const issueBody = process.env.ISSUE_BODY ?? "";
const prompt = `Make a slightly unhinged meme. Favor existing well-known meme-templates if any relevant ones exist.
Extra context for the meme: ${issueTitle}. ${issueBody}`.slice(0, 4000);

console.log(`Generating meme for issue #${ISSUE_NUMBER}: ${issueTitle}`);

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

const MAX_RETRIES = 5;
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

    const message = err?.message ?? String(err);
    console.error("Image generation failed:", message);
    postComment(`❌ Meme generation failed.\n\n\`\`\`\n${message}\n\`\`\``);
    process.exit(1);
  }
}

const b64 = result.data?.[0]?.b64_json;
if (b64 == null) {
  const errorMsg = "No image data returned from API.";
  console.error(errorMsg);
  postComment(`❌ Meme generation failed.\n\n\`\`\`\n${errorMsg}\n\`\`\``);
  process.exit(1);
}

fs.writeFileSync(outFile, Buffer.from(b64, "base64"));
console.log(`Saved: memes/${ISSUE_NUMBER}.jpg`);

// Configure git identity for Actions
exec(`git config user.name "github-actions[bot]"`);
exec(`git config user.email "github-actions[bot]@users.noreply.github.com"`);

// Commit + push
exec(`git add "memes/${ISSUE_NUMBER}.jpg"`);
exec(`git commit -m "Add meme for issue #${ISSUE_NUMBER}"`);
exec(`git push origin HEAD`);
console.log(`Pushed.`);

// Comment + close issue
exec(`gh api repos/${REPO}/issues/${ISSUE_NUMBER}/comments -X POST -f body='🎉 Meme generated and committed to [memes/${ISSUE_NUMBER}.jpg](../blob/main/memes/${ISSUE_NUMBER}.jpg)'`);
exec(`gh api repos/${REPO}/issues/${ISSUE_NUMBER} -X PATCH -f state=closed`);
console.log(`Closed issue #${ISSUE_NUMBER}.`);
