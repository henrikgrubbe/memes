# 03 - Convert `callWithRetry` to Effect + Schedule

**What to build:** Provider image calls use `Effect.retry` with a `Schedule`-based retry policy instead of the hand-rolled recursive `callWithRetry` function. `ModerationBlockedError` short-circuits immediately and is not retried. Rate-limit retries wait for the delay parsed from the error (header or message body). The rest of the script is unchanged - `buildProviders` bridges back to the existing `Providers` shape via `Effect.runPromise` so the surrounding code is unaffected.

**Blocked by:** 02 - Add typed error classes.

**Status:** ready-for-agent

- [ ] `callWithRetry` is replaced by an Effect-based implementation using `Effect.retry` and `Schedule`
- [ ] `ModerationBlockedError` is thrown immediately without retrying
- [ ] Rate-limit retries respect the delay parsed from the `retry-after` header or message body, plus `RETRY_DELAY_PADDING_MS`
- [ ] Maximum retries remain `MAX_RETRIES = 10`
- [ ] `buildProviders` still returns the same `Providers` type as before (bridged via `Effect.runPromise`) - the rest of the script compiles and runs unchanged
- [ ] The script's external behavior (which provider is called, how many times, with what delays) is identical to the current implementation
