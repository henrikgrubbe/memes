import { Context, Effect, Layer, Schedule } from "effect";
import { PushFailedError } from "../shared/errors.js";
import { ShellTag } from "./shell.js";

// Deep interface: the single concurrency-safe way to land a change on `main`.
// Callers describe *what* to commit via a CommitPlan; identity, rebasing,
// pushing, retrying, and resetting rejected commits all live behind this seam.
//
// `stage` runs at the start of every attempt, against a freshly rebased tree,
// and returns the repo-relative paths to commit. Running it per attempt lets a
// caller re-derive content that depends on remote state (e.g. folding a new
// entry into a saga's canon after pulling a concurrent writer's update), so
// competing writers serialize cleanly instead of clobbering each other.

export interface CommitPlan {
  readonly message: string;
  readonly stage: Effect.Effect<ReadonlyArray<string>>;
}

export interface GitService {
  readonly commitToMain: (
    plan: CommitPlan,
  ) => Effect.Effect<void, PushFailedError>;
}

export class GitServiceTag extends Context.Tag("GitService")<
  GitServiceTag,
  GitService
>() {}

/** Build a Layer from a pre-constructed GitService implementation (bypasses real git). */
export const makeGitLayer = (impl: GitService): Layer.Layer<GitServiceTag> =>
  Layer.succeed(GitServiceTag, impl);

/** No-op git layer for tests that don't care about git operations. */
export const GitNoOpLayer: Layer.Layer<GitServiceTag> = makeGitLayer({
  commitToMain: () => Effect.void,
});

const MAX_PUSH_RETRIES = 5;

class PushAttemptError {
  public readonly _tag = "PushAttemptError" as const;
}

type GitCommand = (command: string) => Effect.Effect<string, PushAttemptError>;

// Re-derive staged content from a freshly pulled tree on every attempt. Only a
// rejected push needs a reset because the preceding steps have not made a commit.
const commitAttempt = (
  run: GitCommand,
  plan: CommitPlan,
): Effect.Effect<void, PushAttemptError> =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      [
        `git config user.name "github-actions[bot]"`,
        `git config user.email "github-actions[bot]@users.noreply.github.com"`,
        `git pull --rebase origin main`,
      ],
      run,
      { discard: true },
    );

    const paths = yield* plan.stage;
    yield* Effect.forEach(paths, (path) => run(`git add "${path}"`), {
      discard: true,
    });
    yield* run(`git commit -m "${plan.message}"`);
    yield* run(`git push origin HEAD`).pipe(
      Effect.tapError(() => run(`git reset --hard HEAD~1`).pipe(Effect.ignore)),
    );
  });

export const GitLayer: Layer.Layer<GitServiceTag, never, ShellTag> =
  Layer.effect(
    GitServiceTag,
    Effect.gen(function* () {
      const shell = yield* ShellTag;
      const run = (command: string) =>
        shell.run(command).pipe(Effect.mapError(() => new PushAttemptError()));

      return {
        commitToMain: (plan) =>
          Effect.retry(
            commitAttempt(run, plan).pipe(
              Effect.tapError(() => Effect.log("Push failed - retrying...")),
            ),
            Schedule.recurs(MAX_PUSH_RETRIES - 1),
          ).pipe(
            Effect.tap(() => Effect.log(`Pushed to main: ${plan.message}`)),
            Effect.mapError(
              () => new PushFailedError({ attempts: MAX_PUSH_RETRIES }),
            ),
          ),
      } satisfies GitService;
    }),
  );
