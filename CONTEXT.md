# memes — context

## Sagas (continuous context)

A meme can opt in to a shared, evolving context called a **saga**, so
generations can build on each other (recurring characters, running jokes,
story beats).

Two inline tokens in the Slack message opt in (they are stripped from the
prompt before generation, and are case-insensitive; saga names are slugs of
`A–Z a–z 0–9 _ -`):

- `read:<saga>` — prepend that saga's canon to the image prompt for continuity.
- `write:<saga>` — contribute the request to that saga's canon.
- `saga:<saga>` — shorthand for both: read _and_ write the same saga (the usual
  "keep participating in this saga" case).

They are independent: a meme may read one saga, write another, both, or
neither. A space after the colon (`read: the news`) is **not** a directive.

When `write:<saga>` is used without `read:<saga>`, the contribution updates the
canon without generating an image. The issue and Slack thread receive a
confirmation. Combined read/write requests still generate an image before
updating the canon.

### Storage

Each saga is a plain-markdown file `context/<saga>.md` holding the current
**canon** (an evolving summary). It is committed alongside the meme image.

### Compression

On every `write`, a cheap text model (`gpt-4o-mini`) receives the story so far
and the new contribution, then updates the canon as concise Markdown. A
contribution can add, correct, replace, resolve, invalidate, or remove facts
from the canon. The result stays under `MAX_CANON_CHARS` (3000) so a canon plus
the prompt always fits the image prompt cap (`MAX_PROMPT_CHARS`, 4000). If the
model is unavailable the write falls back to a raw capped append, so a meme is
never lost. Concurrent writes to the same saga serialize via `git pull
--rebase` + re-derive (see `scripts/saga.ts`).

Relevant code: `scripts/saga.ts` (service, compression, prompt assembly),
`scripts/saga-directives.ts` (`parseSagaDirectives`), `scripts/config.ts`
(configuration wiring), `scripts/generate-meme.ts` (pipeline wiring).

## Hosted processing

The hosted flow keeps the Slack Workflow's GitHub issue as the ingress: a
signed GitHub issue webhook reaches a small HTTP service, which durably
enqueues the request before returning. A queue-triggered worker performs image
generation, GitHub writes, Saga updates, and Slack notification.

The ingress is implemented in `scripts/webhook-server.ts`.
`scripts/github-webhook.ts` owns signature validation and event decoding, while
`scripts/scaleway-queue.ts` publishes work to Scaleway Queues.
`scripts/worker-server.ts` exposes the native queue-trigger endpoint and
`scripts/hosted-github.ts` persists hosted results through the GitHub REST API.
The worker creates request-scoped `AppConfig`, while its hosted adapters satisfy
the same `MemePublisherService`, `SagaService`, and `NotifierService` interfaces
used by the CLI pipeline. The CLI and GitHub Actions layers retain their
filesystem, git, GitHub CLI, and curl behavior.

Each delivery reserves a deterministic GitHub marker before provider work. The
generated image, optional re-derived saga, and completed marker land in one Git
Data API commit using a non-forced fast-forward with conflict retry. Completed
markers suppress repeated generation and saga application. Slack completion is
claimed in GitHub before posting because incoming webhooks have no idempotency
key; this prevents duplicates but admits a documented missed-notification crash
window. The current GitHub Actions workflow remains authoritative until the
hosted canary and cutover layer is complete.
See `docs/hosting-webhook.md`.
