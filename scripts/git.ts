import {Command, CommandExecutor} from "@effect/platform";
import {Context, Effect, Layer, Schedule} from "effect";
import {ExecError, PushFailedError} from "./errors.js";
import {AppConfigService} from "./config.js";

// ---- GitService -------------------------------------------------------------
// Deep interface: callers hand over a memeId; committing, retrying pushes,
// and git configuration all live behind this seam.

export interface GitService {
    commitAndPush(memeId: string): Effect.Effect<void, PushFailedError>;
}

export class GitServiceTag extends Context.Tag("GitService")<GitServiceTag, GitService>() {}

// ---- Test helper ------------------------------------------------------------

/** Build a Layer from a pre-constructed GitService implementation (bypasses real git). */
export const makeGitLayer = (impl: GitService): Layer.Layer<GitServiceTag> =>
    Layer.succeed(GitServiceTag, impl);

/** No-op git layer for tests that don't care about git operations. */
export const GitNoOpLayer: Layer.Layer<GitServiceTag> =
    makeGitLayer({commitAndPush: () => Effect.void});

// ---- Real adapter -----------------------------------------------------------

const MAX_PUSH_RETRIES = 5;

// Internal: single failed push attempt — sentinel for the push retry loop.
class PushAttemptError { readonly _tag = "PushAttemptError" as const; }

const exec = (cmd: string): Effect.Effect<string, ExecError, CommandExecutor.CommandExecutor> =>
    Command.make("sh", "-c", cmd).pipe(
        Command.string,
        Effect.mapError((e) => new ExecError({cmd, detail: String(e)})),
        Effect.map((s) => s.trim()),
    );

export const GitLayer: Layer.Layer<GitServiceTag, never, CommandExecutor.CommandExecutor | AppConfigService> =
    Layer.effect(
        GitServiceTag,
        Effect.gen(function* () {
            yield* CommandExecutor.CommandExecutor;
            yield* AppConfigService;
            return {
                commitAndPush: (memeId: string): Effect.Effect<void, PushFailedError, CommandExecutor.CommandExecutor | AppConfigService> =>
                    Effect.gen(function* () {
                        const config = yield* AppConfigService;
                        const run    = (cmd: string) => exec(cmd).pipe(Effect.mapError(() => new PushFailedError({attempts: 0})));

                        yield* run(`git config user.name "github-actions[bot]"`);
                        yield* run(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
                        yield* run(`git add "memes/${memeId}.jpg"`);
                        yield* run(`git commit -m "Add meme for issue #${config.issueNumber} (${memeId})"`);
                        yield* Effect.log(`Committed memes/${memeId}.jpg`);

                        const pushAttempt = exec(`git pull --rebase origin main`).pipe(
                            Effect.flatMap(() => exec(`git push origin HEAD`)),
                            Effect.mapError(() => new PushAttemptError()),
                        );

                        yield* Effect.retry(
                            pushAttempt.pipe(Effect.tapError(() => Effect.log("Push failed - retrying..."))),
                            Schedule.recurs(MAX_PUSH_RETRIES - 1),
                        ).pipe(
                            Effect.tap(() => Effect.log(`Pushed memes/${memeId}.jpg`)),
                            Effect.mapError(() => new PushFailedError({attempts: MAX_PUSH_RETRIES})),
                        );
                    }),
            } satisfies GitService;
        }),
    );
