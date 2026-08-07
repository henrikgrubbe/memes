# 02 - Add typed error classes

**What to build:** Tagged error classes for every failure mode in the meme-generation pipeline exist in the codebase and are exported. The existing script is not modified — these classes are defined alongside it but not yet wired in. No behavior change; this is a pure addition that unblocks the Effect migration.

**Blocked by:** None - can start immediately.

**Status:** resolved

- [x] Tagged error classes defined: `EnvMissingError`, `IssueBodyMissingFieldError`, `ModerationBlockedError`, `RateLimitExhaustedError`, `ExecError`, `PushFailedError`, `ProviderError`
- [x] Each class has a `readonly _tag` discriminant equal to its class name
- [x] Each class carries the minimum context needed for a useful failure message (e.g. `EnvMissingError` carries the missing key name)
- [x] The existing `ModerationError` class is kept unchanged — it will be replaced by `ModerationBlockedError` in a later ticket
- [x] The script's runtime behavior is identical before and after this change
