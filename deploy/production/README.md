# Hamnivo in production

Everything needed to run Hamnivo on one server with Docker. The step-by-step guide, from DNS
records to backups and updates, is Part A of [`docs/self-hosting.md`](../../docs/self-hosting.md).

```bash
./deploy/production/hamnivo.sh setup --domain example.com --email you@example.com
./deploy/production/hamnivo.sh up
```

| File | What it is |
|---|---|
| `hamnivo.sh` | The operator script: `setup`, `up`, `status`, `logs`, `backup`, `restore`, `update`, `down`, `compose` |
| `compose.yml` | The services: PostgreSQL 18 + pgvector, Valkey, the gateway (migrations, API, worker), Chatwoot 4.18.0-ce, ClamAV, and the edge |
| `Caddyfile` | The edge: automatic HTTPS, the reverse proxies, the static widget and website, and the widget's frame policy |
| `env.example` | Every setting in `.env`, which `hamnivo.sh setup` writes with generated secrets |
| `chatwoot.env.example` | Optional Chatwoot settings, such as its email |
| `../docker/Dockerfile` | The two images, built from this code: `gateway` and `edge` |

`.env`, `chatwoot.env` and `backups/` stay on the server: git and Docker builds ignore them.

`bash scripts/ci/production-smoke.sh` deploys this stack on the current machine, using Caddy's
internal certificates, in its own compose project. It checks the deployment end to end, runs a
backup and restore drill, then deletes everything it created.
