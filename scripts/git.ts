import {Command, CommandExecutor} from "@effect/platform";
import {Context, Effect, Layer, Schedule} from "effect";
import {PushFailedError} from "./errors.js";
import {AppConfigService} from "./config.js";

// ---- GitService -------------------------------------------------------------
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
    readonly stage:   Effect.Effect<ReadonlyArray<string>>;
}

export interface GitService {
    commitToMain(plan: CommitPlan): Effect.Effect<void, PushFailedError>;
}

export class GitServiceTag extends Context.Tag("GitService")<GitServiceTag, GitService>() {}

// ---- Test helper ------------------------------------------------------------

/** Build a Layer from a pre-constructed GitService implementation (bypasses real git). */
export const makeGitLayer = (impl: GitService): Layer.Layer<GitServiceTag> =>
    Layer.succeed(GitServiceTag, impl);

/** No-op git layer for tests that don't care about git operations. */
export const GitNoOpLayer: Layer.Layer<GitServiceTag> =
    makeGitLayer({commitToMain: () => Effect.void});

// ---- Real adapter -----------------------------------------------------------

const MAX_PUSH_RETRIES = 5;

// Internal: one rejected attempt — sentinel for the retry loop.
class PushAttemptError { readonly _tag = "PushAttemptError" as const; }

const exec = (executor: CommandExecutor.CommandExecutor, cmd: string): Effect.Effect<string, PushAttemptError> =>
    Command.make("sh", "-c", cmd).pipe(
        Command.string,
        Effect.mapError(() => new PushAttemptError()),
        Effect.map((s) => s.trim()),
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
    );

export const GitLayer: Layer.Layer<GitServiceTag, never, CommandExecutor.CommandExecutor | AppConfigService> =
    Layer.effect(
        GitServiceTag,
        Effect.gen(function* () {
            // Capture the executor once, at layer construction, so the service
            // method itself requires nothing from context (R = never).
            const executor = yield* CommandExecutor.CommandExecutor;
            const run      = (cmd: string) => exec(executor, cmd);

            const configureIdentity = run(`git config user.name "github-actions[bot]"`).pipe(
                Effect.zipRight(run(`git config user.email "github-actions[bot]@users.noreply.github.com"`)),
            );

            // One pull-fresh-tree, stage, commit, push. On push rejection the
            // local commit is dropped so the next attempt re-derives from the
            // updated remote; any earlier failure (pull/stage/commit) simply
            // retries without a reset, since nothing was committed yet.
            const attempt = (plan: CommitPlan): Effect.Effect<void, PushAttemptError> =>
                Effect.gen(function* () {
                    yield* configureIdentity;
                    yield* run(`git pull --rebase origin main`);
                    const paths = yield* plan.stage;
                    for (const path of paths) { yield* run(`git add "${path}"`); }
                    yield* run(`git commit -m "${plan.message}"`);
                    yield* run(`git push origin HEAD`).pipe(
                        Effect.tapError(() => run(`git reset --hard HEAD~1`).pipe(Effect.ignore)),
                    );
                });

            return {
                commitToMain: (plan: CommitPlan): Effect.Effect<void, PushFailedError> =>
                    Effect.retry(
                        attempt(plan).pipe(Effect.tapError(() => Effect.log("Push failed - retrying..."))),
                        Schedule.recurs(MAX_PUSH_RETRIES - 1),
                    ).pipe(
                        Effect.tap(() => Effect.log(`Pushed to main: ${plan.message}`)),
                        Effect.mapError(() => new PushFailedError({attempts: MAX_PUSH_RETRIES})),
                    ),
            } satisfies GitService;
        }),
    );
