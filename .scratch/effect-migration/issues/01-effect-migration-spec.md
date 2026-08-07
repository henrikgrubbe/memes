Status: ready-for-agent

# Spec: Migrate `generate-meme.ts` to Effect

## Problem Statement

`scripts/generate-meme.ts` is a GitHub Actions script that generates memes via AI image providers. Its control flow has grown organically and now has several pain points:

- Retry logic (`callWithRetry`) is a hand-rolled recursive function that's difficult to reason about and test.
- Failure handling is scattered: `process.exit(1)` is called from `fail()` and `failAndClose()` at multiple depths in the call stack, making it hard to see all failure modes and ensure cleanup always runs.
- The `Ctx` object is passed as the first argument to every function, which is a form of manual dependency injection that scales poorly and makes functions harder to test in isolation.
- Error types are untagged (`throw new Error(...)`), so there's no way to see from a function's signature what can go wrong.

The script currently has no tests. The combination of side effects embedded in every function and no dependency injection makes writing tests impractical without significant refactoring.

## Solution

Rewrite `scripts/generate-meme.ts` using the [Effect](https://effect.website) library. Effect provides:

- A typed error channel, so every function's failure modes are explicit in its return type.
- `Schedule`-based retry policies, replacing the hand-rolled `callWithRetry` recursion.
- `Context`/`Layer` for dependency injection, replacing the `Ctx` parameter pattern.
- A single top-level `catchAll` that handles all failure cleanup, replacing `fail()`/`failAndClose()`.

The migrated script runs as a one-shot Node.js process (not a server), exits via `Effect.runPromise`, and is functionally identical to the current script from the GitHub Actions workflow's perspective.

## User Stories

1. As a developer maintaining this script, I want retry logic expressed as a composable `Schedule`, so that I can understand and change the retry policy without tracing recursive call stacks.
2. As a developer, I want all failure modes visible in function signatures via typed error channels, so that I can audit what can go wrong without reading every function body.
3. As a developer, I want a single cleanup path at the top of the pipeline, so that I can be confident failure notifications and issue-close calls always run regardless of where the failure originated.
4. As a developer, I want `ExecService`, `ProvidersService`, and `ConfigService` injected via Effect Layers, so that I can swap in test doubles without modifying the program logic.
5. As a developer, I want the script's orchestration logic covered by tests, so that I can refactor with confidence.
6. As a developer, I want the primary provider selection, moderation fallback, and rate-limit retry logic each tested independently via mock Layers, so that I can verify edge-case behavior without calling real APIs.
7. As a developer, I want the push-retry logic tested with a mock `ExecService`, so that I can verify it retries the correct number of times and fails cleanly.
8. As a developer, I want env-var reading and issue-body parsing tested as pure functions, so that I can verify field extraction without constructing a full `Ctx`.
9. As a GitHub Actions workflow, I want the script to exit with code 0 on success and code 1 on failure, exactly as today, so that the workflow status is unaffected by the migration.
10. As a developer, I want the script's external behavior (GitHub issue comments, Slack posts, git commits) unchanged, so that the migration is transparent to end users.
11. As a developer, I want the moderation fallback path tested - primary blocked, fallback succeeds - so that this critical recovery path is verified.
12. As a developer, I want the double-moderation failure path tested - primary and fallback both blocked - so that issue-close-on-failure is verified.
13. As a developer, I want rate-limit exhaustion tested - all retries consumed - so that the terminal rate-limit failure path is verified.

## Implementation Decisions

- **Typed error channel.** Define tagged error classes for each failure mode: `EnvMissingError`, `IssueBodyMissingFieldError`, `ModerationBlockedError`, `RateLimitExhaustedError`, `ExecError`, `PushFailedError`, `ProviderError`. Each carries the minimum context needed for a useful failure message.

- **Service tags.** Three `Context.Tag`s replace `Ctx`:
  - `ExecService` — wraps `execSync`; signature `(cmd: string) => Effect<string, ExecError>`
  - `ProvidersService` — maps provider name to `(prompt: string) => Effect<{ buffer: Buffer; rateLimitHits: number }, ModerationBlockedError | RateLimitExhaustedError | ProviderError>`
  - `ConfigService` — holds the parsed, validated config (issue number, repo, Slack URL, meme prompt, etc.)

- **`callWithRetry` becomes `Effect.retry` with `Schedule`.** The rate-limit delay is extracted from the error in a `Schedule.addDelay` step. Moderation errors are not retried — the `Schedule` predicate filters to only `RateLimitExhaustedError`. Maximum retries remain `MAX_RETRIES = 10`.

- **Main pipeline shape.** `Effect.gen` top-level, yielding: `readConfig` → `waitForJitter` → `generateImage` → `saveImage` → `commitAndPush` → `notifySuccess`. A single `.pipe(Effect.catchAll(postFailureAndExit))` at the top handles all failure paths, replacing `fail()`/`failAndClose()`.

- **`failAndClose` semantics preserved.** The `catchAll` handler checks whether the error warrants closing the issue (i.e., it is a double-moderation failure, not a transient infra error) and calls `gh api` accordingly. This logic moves from call-site to a single place.

- **Entry point.** Replace `main()` at the bottom of the file with:
  ```ts
  Effect.runPromise(Effect.provide(program, AppLayer)).catch(() => process.exit(1));
  ```
  `AppLayer` is composed from `ExecLayer`, `ProvidersLayer`, and `ConfigLayer`.

- **No `ManagedRuntime`.** A one-shot script does not need long-lived resource pools. `Effect.provide` at the call site is sufficient.

- **`Effect.log` / `Effect.logWarning` / `Effect.logError`.** Replace `console.log`, `console.warn`, `console.error` throughout.

- **Migration order (step-by-step, de-risked):**
  1. Add typed error classes — no behavior change.
  2. Convert `callWithRetry` to Effect + Schedule — highest value, self-contained.
  3. Convert `readEnv`/`buildCtx` to `ConfigService` Effect + Layer.
  4. Wire the main pipeline with `Effect.gen` and `catchAll`.
  5. Convert `ExecService` and `ProvidersService` to Layers.

## Testing Decisions

- **What makes a good test.** Tests should assert on observable external behavior, not on internal call sequences. For this script, observable behavior means: which Effect errors are returned, whether the image buffer is correct, and which services were called (via mock Layer spy). Tests should not assert on the order of `console.log` lines or internal retry counter values.

- **Testing seam.** One seam: the top-level Effect program, provided with mock Layers. Tests construct `TestExecLayer`, `TestProvidersLayer`, and `TestConfigLayer`, then run the program with `Effect.runPromiseExit`. This exercises the full orchestration with no real API calls or git operations.

- **Modules under test.** `scripts/generate-meme.ts` — specifically the orchestration logic: provider selection, moderation fallback, rate-limit retry, push-retry, and failure cleanup.

- **Key test cases:**
  - Happy path: primary provider succeeds on first attempt.
  - Rate-limit retry: primary returns rate-limit errors N times, then succeeds.
  - Moderation fallback: primary returns `ModerationBlockedError`, fallback succeeds.
  - Double moderation: primary and fallback both return `ModerationBlockedError` — program fails and closes the issue.
  - Rate-limit exhaustion: all `MAX_RETRIES` consumed — program fails.
  - Push retry: `ExecService` fails on `git push` N times, then succeeds.
  - Push exhaustion: all `MAX_PUSH_RETRIES` consumed — program fails.
  - Missing env var: `ConfigService` fails with `EnvMissingError` — program fails without attempting generation.

- **Prior art.** The codebase currently has no tests. The test file will be the first — use Vitest (already likely in the project) or the runtime's default test runner.

## Out of Scope

- Changing the script's external behavior (GitHub issue format, Slack payload shape, git commit message).
- Adding new image providers or changing provider parameters.
- Moving the script to a different language or runtime.
- Changing the GitHub Actions workflow YAML.
- Adding observability (tracing, metrics) beyond the existing `console.log` statements.
- `Effect.Stream` or `Effect.Queue` — not needed for a one-shot sequential pipeline.

## Further Notes

- The user is learning Effect as part of this migration. The goal is to understand Effect well enough to write it, not just accept generated code. Prefer `Effect.gen` style over long `pipe` chains for readability while learning.
- The `Schedule` for rate-limit retry needs to extract the delay from the error itself (parsed from the `retry-after` header or message body). This is a non-standard `Schedule` use — `Schedule.recurWhile` + `Effect.delay` inside the effect itself may be simpler than a custom `Schedule.addDelay` until the API is familiar.
- Effect's `TestClock` can fast-forward `Duration` delays in tests, avoiding real `sleep` calls in retry tests.
