# 07 - Add test harness and orchestration tests

**What to build:** Vitest is set up and a test suite covers the script's orchestration logic through mock Layers. Tests verify the happy path, all retry/fallback paths, and all terminal failure paths without calling real APIs or running git commands. `TestClock` is used so retry-delay tests run instantly.

**Blocked by:** 06 - Add `ExecService` and `ProvidersService` Layers.

**Status:** ready-for-agent

- [ ] Vitest installed and configured (or existing test runner confirmed)
- [ ] `TestExecLayer`, `TestProvidersLayer`, and `TestConfigLayer` test doubles implemented
- [ ] Happy path: primary provider succeeds on first attempt - program exits successfully, image buffer is correct
- [ ] Rate-limit retry: primary returns rate-limit errors N times then succeeds - program retries and succeeds
- [ ] Rate-limit exhaustion: all `MAX_RETRIES` consumed - program fails with `RateLimitExhaustedError`
- [ ] Moderation fallback: primary returns `ModerationBlockedError`, fallback succeeds - program succeeds using fallback buffer
- [ ] Double moderation: primary and fallback both return `ModerationBlockedError` - program fails and the issue-close command is issued via `ExecService`
- [ ] Push retry: `ExecService` fails on `git push` N times then succeeds - program succeeds
- [ ] Push exhaustion: all `MAX_PUSH_RETRIES` consumed - program fails with `PushFailedError`
- [ ] Missing env var: `ConfigLayer` fails with `EnvMissingError` - program fails before attempting generation
- [ ] `TestClock` used so no test waits on real sleep durations
- [ ] All tests pass in CI
