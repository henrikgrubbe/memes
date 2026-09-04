# memes

Meme requests run through the existing CLI/GitHub Actions path by default.

The optional Scaleway-hosted webhook and queue worker deployment is documented
in [docs/hosting-webhook.md](docs/hosting-webhook.md). Its repeatable human setup
wizard is:

```bash
./infra/scaleway/setup.sh
```

Deployment is inert by default and does not disable the Actions fallback.