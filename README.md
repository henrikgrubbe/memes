# memes

Meme requests can run through the CLI/GitHub Actions path or the hosted
Scaleway path. The `MEME_PROCESSING_BACKEND` repository variable selects the
active backend.

## Repository layout

| Path                  | Responsibility                                      |
| --------------------- | --------------------------------------------------- |
| `src/shared`          | Generation, Saga, formatting, and shared interfaces |
| `src/cli`             | GitHub Actions and local command adapters           |
| `src/hosted/ingress`  | Signed GitHub webhook and FIFO queue publishing     |
| `src/hosted/worker`   | Queue processing and hosted GitHub/Slack adapters   |
| `infra/scaleway`      | Infrastructure, runtime images, and deployment      |
| `context` and `memes` | Generated Saga canon and meme output                |

The Scaleway-hosted webhook and queue worker are documented in
[docs/hosting-webhook.md](docs/hosting-webhook.md). Initial infrastructure setup
uses:

```bash
./infra/scaleway/setup.sh
```

After setup, merges to `main` deploy only affected hosted runtimes through the
GitHub `production` Environment. Infrastructure remains inert by default and
does not disable the Actions fallback.
