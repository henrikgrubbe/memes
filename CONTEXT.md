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
**canon** (an evolving summary). Hosted processing commits it after image
publication while notification proceeds in parallel.

### Compression

On every `write`, a cheap text model (`gpt-4o-mini`) receives the story so far
and the new contribution, then updates the canon as concise Markdown. A
contribution can add, correct, replace, resolve, invalidate, or remove facts
from the canon. The result stays under `MAX_CANON_CHARS` (3000) so a canon plus
the prompt always fits the image prompt cap (`MAX_PROMPT_CHARS`, 4000). If the
model is unavailable the write falls back to a raw capped append, so a meme is
never lost. Concurrent writes to the same saga serialize via `git pull
--rebase` + re-derive (see `src/shared/saga.ts` and `src/cli/saga.ts`).

Relevant code: `src/shared/saga.ts` (interface, compression, prompt assembly),
`src/cli/saga.ts` (filesystem/git adapter), `src/shared/saga-directives.ts`
(`parseSagaDirectives`), `src/shared/config.ts` (configuration wiring), and
`src/cli/generate-meme.ts` (pipeline wiring).

## Hosted processing

The hosted flow keeps the Slack Workflow's GitHub issue as the ingress: a
signed GitHub issue webhook reaches a small HTTP service, which durably
enqueues the request before returning. A queue-triggered worker performs image
generation, GitHub writes, Saga updates, and Slack notification.

The ingress module lives in `src/hosted/ingress`; its GitHub webhook adapter
owns signature validation and event decoding, while its Scaleway queue adapter
publishes work to Scaleway Queues. The worker module lives in
`src/hosted/worker`; its server exposes the native queue-trigger endpoint and
its Object Storage adapter publishes new hosted JPEGs, while its GitHub adapter
owns issue comments/closure and Saga commits. The worker creates request-scoped
`AppConfig` and directly orchestrates these adapters around the shared provider,
prompt, and Saga helpers. The CLI and GitHub Actions layers retain their
filesystem, git, GitHub CLI, curl, and GitHub-hosted image behavior.

Hosted images use deterministic `memes/<memeId>.jpg` keys in a Scaleway Object
Storage bucket. `HeadObject` is the publication gate; a missing object is
generated and written with `If-None-Match: *`, and `412` means another worker
won. The image carries bounded provider/cost/usage metadata so retries can form
a correct degraded notification without another provider call. Terminal
generation failures have no image receipt, so a private conditional
`terminal-outcomes/<memeId>.json` record prevents repeated provider calls during
notification retries. Successful images never get a sidecar.

Slack notification and an optional Saga update run independently in parallel:
a failure in either branch does not interrupt the other, but still makes the
queue delivery retryable after both finish. Saga writes atomically commit
`context/<saga>.md` with a minimal delivery-ID/Saga/folded receipt under
`.github/meme-worker/saga-folds/`; the receipt prevents duplicate folding for
both read/write and write-only requests. GitHub stores no general delivery
marker or newly hosted image. Slack retries can duplicate a notification in a
narrow failure window, and a provider-success crash before the conditional
object write can repeat billing. Hosted Object Storage, GitHub, Saga
persistence, and Slack I/O failures remain retryable. Deployment is defined in
`infra/scaleway`: OpenTofu owns infrastructure, while GitHub Actions builds
immutable runtime images and records deployments through the protected
`production` Environment.
Its safe defaults are ingress off, worker diagnostic, queue trigger absent, and
GitHub Actions authoritative. The workflow remains in place permanently and is
selected unless repository variable `MEME_PROCESSING_BACKEND` is exactly
`hosted`. Issues created with the `hosted-canary` label are excluded from
Actions and are the only deliveries admitted by canary ingress, preventing one
request from running in both backends.

Cutover pauses upstream intake, detaches the trigger, changes Actions authority,
opens live ingress so the queue can buffer, then activates the live worker at
maximum scale one. Rollback reverses those gates and assigns each buffered
delivery to exactly one backend. Scaleway's full trigger envelope,
acknowledgement timing, retry delay, DLQ interaction, and private-container
compatibility remain live-canary facts rather than assumed guarantees.
See `docs/hosting-webhook.md`.
