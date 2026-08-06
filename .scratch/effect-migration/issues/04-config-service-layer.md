# 04 - Add `ConfigService` Layer

**What to build:** `readEnv` and `buildCtx` become an Effect pipeline that yields a `ConfigService` holding the fully validated configuration. Env-var failures surface as `EnvMissingError` and issue-body field failures as `IssueBodyMissingFieldError` in the typed error channel, replacing the `process.exit(1)` calls at startup. The layer is wired in at the entry point; the rest of the script still receives its inputs in their current form.

**Blocked by:** 02 - Add typed error classes.

**Status:** ready-for-agent

- [ ] `ConfigService` Context.Tag defined, holding all config fields currently in `Ctx` (issue number, repo, Slack URL, meme prompt, channel, Slack link)
- [ ] `ConfigLayer` builds the service by reading and validating env vars and parsing the issue body
- [ ] Missing env vars yield `EnvMissingError` with the missing key
- [ ] Missing issue-body fields yield `IssueBodyMissingFieldError` with the field name
- [ ] `process.exit(1)` is removed from `readEnv` and `buildCtx`
- [ ] `parseIssueBody` remains a pure function and is unchanged
- [ ] The script's startup behavior (which error is logged and when the process exits) is identical to the current implementation
