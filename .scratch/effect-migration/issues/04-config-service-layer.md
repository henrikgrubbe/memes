# 04 - Add `ConfigService` Layer

**What to build:** `readEnv` and `buildCtx` become an Effect pipeline that yields a `ConfigService` holding the fully validated configuration. Env-var failures surface as `EnvMissingError` and issue-body field failures as `IssueBodyMissingFieldError` in the typed error channel, replacing the `process.exit(1)` calls at startup. The layer is wired in at the entry point; the rest of the script still receives its inputs in their current form.

**Blocked by:** 02 - Add typed error classes.

**Status:** resolved

- [x] `ConfigService` Context.Tag defined, holding all config fields currently in `Ctx` (issue number, repo, Slack URL, meme prompt, channel, Slack link)
- [x] `ConfigLayer` builds the service by reading and validating env vars and parsing the issue body
- [x] Missing env vars yield `EnvMissingError` with the missing key
- [x] Missing issue-body fields yield `IssueBodyMissingFieldError` with the field name
- [x] `process.exit(1)` is removed from `readEnv` and `buildCtx`
- [x] `parseIssueBody` remains a pure function and is unchanged
- [x] The script's startup behavior (which error is logged and when the process exits) is identical to the current implementation
