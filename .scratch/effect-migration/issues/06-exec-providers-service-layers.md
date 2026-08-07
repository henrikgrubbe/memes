# 06 - Add `ExecService` and `ProvidersService` Layers

**What to build:** `execSync` and the OpenAI clients are injected via `ExecService` and `ProvidersService` Context Layers. The `Ctx` object and all functions that took it as a first parameter are refactored to yield services via `yield*` instead. `Ctx` is deleted.

**Blocked by:** 05 - Wire main pipeline with `Effect.gen` + `catchAll`.

**Status:** ready-for-agent

- [ ] `ExecService` Context.Tag defined: `(cmd: string) => Effect<string, ExecError>`
- [ ] `ExecLayer` builds the service using `execSync` with `cwd` set to the repo root
- [ ] `ProvidersService` Context.Tag defined: maps provider name to `(prompt: string) => Effect<{ buffer: Buffer; rateLimitHits: number }, ModerationBlockedError | RateLimitExhaustedError | ProviderError>`
- [ ] `ProvidersLayer` builds the service from `PROVIDER_CONFIGS` and the API key env vars
- [ ] All functions that previously took `ctx` as a first parameter now yield `ExecService`, `ProvidersService`, or `ConfigService` directly via `yield*`
- [ ] `Ctx`, `Exec`, and `Providers` types are deleted
- [ ] `AppLayer` is updated to compose `ExecLayer`, `ProvidersLayer`, and `ConfigLayer`
- [ ] The script's external behavior is unchanged
- [ ] The original `ModerationError` class is removed, fully replaced by `ModerationBlockedError`
