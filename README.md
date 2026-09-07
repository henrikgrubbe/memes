# memes

Meme requests are processed by a Scaleway-hosted webhook, FIFO queue, and
worker.

## Repository layout

| Path                 | Responsibility                                        |
| -------------------- | ----------------------------------------------------- |
| `src/shared`         | Image generation, provider history, and Saga behavior |
| `src/hosted/ingress` | Signed GitHub webhook and FIFO queue publishing       |
| `src/hosted/worker`  | Queue processing and hosted GitHub/Slack adapters     |
| `infra/scaleway`     | Infrastructure, runtime images, and deployment        |
| `context`            | Generated Saga canon                                  |
| `memes`              | Historical images from the retired Actions backend    |

Provisioning, deployment, and operations are documented in
[docs/hosting-webhook.md](docs/hosting-webhook.md).

After setup, merges to `main` deploy only affected hosted runtimes through the
GitHub `production` Environment.

## Sponsorship

[Sponsor this project](https://github.com/sponsors/henrikgrubbe) to help cover
Scaleway hosting, Object Storage, and AI image-generation provider costs.
