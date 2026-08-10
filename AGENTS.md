# Agent Guide — memes

## Vendored repositories

External repositories are vendored under `repos/` as git subtrees.

- Use them as **read-only reference material** — do not edit files under `repos/`
- Do **not** import from `repos/` — application code imports from normal package dependencies (e.g. `effect`)
- Prefer patterns and examples from the vendored source over generated guesses or web search

### Effect (`repos/effect`)

When writing Effect code, explore `repos/effect` for idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

Before writing any Effect code, read `repos/effect/LLMS.md` for a concise orientation.

## Issue tracking

Local issues live under `.scratch/` as markdown files. See `docs/agents/issue-tracker.md`.

## Domain docs

See `CONTEXT.md` at the repo root and `docs/adr/` for architectural decisions.
