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
const prompt = `Make a slightly unhinged meme. Favor existing well-known meme-templates if any relevant ones exist.
Extra context for the meme: ${title}.`.slice(0, 4000);

console.log(`Generating meme for issue #${ISSUE_NUMBER}: ${title}`);

const result = await openai.images.generate({
  model: "gpt-image-2",
  prompt,
  size: "1536x1024",
  quality: "low",
  output_format: "jpeg",
});

const b64 = result.data?.[0]?.b64_json;
if (!b64) { console.error("No image data returned"); process.exit(1); }

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
