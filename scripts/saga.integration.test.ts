import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodeCommandExecutor,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppConfigService, type AppConfig } from "./config.js";
import { SagaServiceTag, SagaLayer } from "./saga.js";
import { GitLayer } from "./git.js";
import { ShellLayer } from "./shell.js";

// Exercises the real read -> compress(fallback) -> write -> commit -> push loop
// against a throwaway git repo. OPENAI_API_KEY is left unset so compression
// deterministically uses the raw-append fallback (no network).

const dummyConfig: AppConfig = {
  issueNumber: "42",
  repo: "o/r",
  slackWebhookUrl: "",
  requester: "u",
  memePrompt: "",
  channel: "#c",
  slackLink: "",
  readSaga: null,
  writeSaga: null,
};

const git = (cwd: string, cmd: string) =>
  execSync(`git ${cmd}`, { cwd, stdio: "pipe" }).toString();

let root: string;
let remote: string;
let work: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "saga-"));
  remote = join(root, "remote.git");
  work = join(root, "work");
  execSync(`git init --bare -b main "${remote}"`);
  execSync(`git clone "${remote}" "${work}"`, { stdio: "pipe" });
  git(work, `config user.name test`);
  git(work, `config user.email test@test`);
  // Seed an initial commit so `main` exists on the remote.
  execSync(`touch "${join(work, "README.md")}"`);
  git(work, `add README.md`);
  git(work, `commit -m init`);
  git(work, `push origin main`);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

const contribute = (saga: string, prompt: string) => {
  const infra = Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
    Layer.succeed(AppConfigService, dummyConfig),
  );
  const layer = SagaLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        infra,
        GitLayer.pipe(Layer.provide(ShellLayer.pipe(Layer.provide(infra)))),
      ),
    ),
  );
  const program = SagaServiceTag.pipe(
    Effect.flatMap((s) => s.contribute(saga, prompt)),
  );
  return Effect.runPromise(
    program.pipe(
      Effect.provide(layer),
      // No OPENAI_API_KEY -> forces the append fallback.
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
    ),
  );
};

describe("SagaService.contribute (integration)", () => {
  it("creates, commits and pushes a saga canon on first write", async () => {
    process.chdir(work);
    await contribute("heist", "a cat cracks a safe");

    const canon = readFileSync(join(work, "context", "heist.md"), "utf8");
    expect(canon).toContain("a cat cracks a safe");

    // The commit reached the remote.
    const remoteLog = git(work, `log origin/main --oneline`);
    expect(remoteLog).toContain("Update saga heist for issue #42");
  });

  it("folds a second write into the existing canon", async () => {
    process.chdir(work);
    await contribute("heist", "first idea");
    await contribute("heist", "second idea");

    const canon = readFileSync(join(work, "context", "heist.md"), "utf8");
    expect(canon).toContain("first idea");
    expect(canon).toContain("second idea");
  });

  it("picks up a concurrent remote canon update via pull --rebase before writing", async () => {
    process.chdir(work);
    await contribute("heist", "local idea");

    // Simulate another runner pushing to the same saga from a second clone.
    const other = join(root, "other");
    execSync(`git clone "${remote}" "${other}"`, { stdio: "pipe" });
    git(other, `config user.name other`);
    git(other, `config user.email other@test`);
    execSync(`mkdir -p "${join(other, "context")}"`);
    execSync(
      `printf 'remote idea\\n' > "${join(other, "context", "heist.md")}"`,
    );
    git(other, `add context/heist.md`);
    git(other, `commit -m "remote update"`);
    git(other, `push origin main`);

    // Our next contribute must rebase onto the remote change and preserve it.
    await contribute("heist", "another local idea");

    const canon = readFileSync(join(work, "context", "heist.md"), "utf8");
    expect(canon).toContain("remote idea");
    expect(canon).toContain("another local idea");
  });
});
