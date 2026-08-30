import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppConfigService, type AppConfig } from "./config.js";
import { GitServiceTag, GitLayer } from "./git.js";
import { ShellLayer } from "./shell.js";

// Exercises the real configure -> pull --rebase -> stage -> commit -> push loop
// against a throwaway git repo, through the GitService seam. The staged file is
// (re)written inside the plan's `stage` effect, matching how generate-meme and
// the saga hand their content to commitToMain.

const dummyConfig: AppConfig = {
  issueNumber: "7",
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
  root = mkdtempSync(join(tmpdir(), "git-"));
  remote = join(root, "remote.git");
  work = join(root, "work");
  execSync(`git init --bare -b main "${remote}"`);
  execSync(`git clone "${remote}" "${work}"`, { stdio: "pipe" });
  git(work, `config user.name test`);
  git(work, `config user.email test@test`);
  execSync(`touch "${join(work, "README.md")}"`);
  git(work, `add README.md`);
  git(work, `commit -m init`);
  git(work, `push origin main`);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

const commit = (message: string, stage: () => ReadonlyArray<string>) => {
  const infra = Layer.mergeAll(
    NodeFileSystem.layer,
    NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
    Layer.succeed(AppConfigService, dummyConfig),
  );
  const layer = GitLayer.pipe(
    Layer.provide(ShellLayer.pipe(Layer.provide(infra))),
  );
  const program = GitServiceTag.pipe(
    Effect.flatMap((g) =>
      g.commitToMain({ message, stage: Effect.sync(stage) }),
    ),
  );
  return Effect.runPromise(program.pipe(Effect.provide(layer)));
};

describe("GitService.commitToMain (integration)", () => {
  it("stages, commits and pushes the planned file", async () => {
    process.chdir(work);
    await commit("Add meme for issue #7", () => {
      mkdirSync(join(work, "memes"), { recursive: true });
      writeFileSync(join(work, "memes", "a.jpg"), "image-a");
      return ["memes/a.jpg"];
    });

    const remoteLog = git(work, `log origin/main --oneline`);
    expect(remoteLog).toContain("Add meme for issue #7");
    expect(git(work, `show origin/main:memes/a.jpg`)).toBe("image-a");
  });

  it("rebases onto a concurrent remote change and preserves both files", async () => {
    process.chdir(work);
    await commit("Add meme for issue #7", () => {
      mkdirSync(join(work, "memes"), { recursive: true });
      writeFileSync(join(work, "memes", "a.jpg"), "image-a");
      return ["memes/a.jpg"];
    });

    // A second runner pushes an unrelated change from another clone.
    const other = join(root, "other");
    execSync(`git clone "${remote}" "${other}"`, { stdio: "pipe" });
    git(other, `config user.name other`);
    git(other, `config user.email other@test`);
    mkdirSync(join(other, "memes"), { recursive: true });
    writeFileSync(join(other, "memes", "b.jpg"), "image-b");
    git(other, `add memes/b.jpg`);
    git(other, `commit -m "remote meme"`);
    git(other, `push origin main`);

    // Our next commit must rebase onto the remote change, not clobber it.
    await commit("Add meme for issue #7 second", () => {
      writeFileSync(join(work, "memes", "c.jpg"), "image-c");
      return ["memes/c.jpg"];
    });

    expect(git(work, `show origin/main:memes/a.jpg`)).toBe("image-a");
    expect(git(work, `show origin/main:memes/b.jpg`)).toBe("image-b");
    expect(git(work, `show origin/main:memes/c.jpg`)).toBe("image-c");
  });
});
