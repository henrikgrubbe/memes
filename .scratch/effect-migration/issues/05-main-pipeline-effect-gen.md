# 05 - Wire main pipeline with `Effect.gen` + `catchAll`

**What to build:** The script's top-level control flow becomes an `Effect.gen` pipeline. `fail()` and `failAndClose()` are deleted and replaced by a single `catchAll` at the top that handles failure notification (GitHub comment + Slack post) and conditionally closes the issue. The entry point becomes `Effect.runPromise(Effect.provide(program, AppLayer))`. The script exits with code 0 on success and code 1 on any unhandled failure, exactly as today.

**Blocked by:** 03 - Convert `callWithRetry` to Effect + Schedule, 04 - Add `ConfigService` Layer.

**Status:** resolved

- [x] `main()` is replaced by an `Effect.gen` pipeline: config -> `waitForJitter` -> `generateImage` -> saveImage -> `commitAndPush` -> `notifySuccess`
- [x] `fail()` and `failAndClose()` are deleted
- [x] A single `catchAll` handles all failure paths: logs the error, posts a GitHub comment, posts to Slack, and closes the issue when the error is a double-moderation failure
- [x] `AppLayer` is composed from `ConfigLayer` and the existing exec/providers setup (not yet full Layers - that is ticket 06)
- [x] Entry point: `Effect.runPromise(Effect.provide(program, AppLayer)).catch(() => process.exit(1))`
- [x] `console.log`, `console.warn`, `console.error` replaced with `Effect.log`, `Effect.logWarning`, `Effect.logError`
- [x] The script's external behavior (GitHub issue comments, Slack payload, git commits, exit codes) is identical to the current implementation
- [x] The GitHub Actions workflow runs successfully end-to-end
