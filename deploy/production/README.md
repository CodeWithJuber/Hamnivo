# Hamnivo in production

Everything needed to run Hamnivo on one server with Docker. The step-by-step guide, from DNS
records to backups and updates, is Part A of [`docs/self-hosting.md`](../../docs/self-hosting.md).

```bash
./deploy/production/hamnivo.sh setup --domain example.com --email you@example.com
./deploy/production/hamnivo.sh up
```

| File | What it is |
|---|---|
| `hamnivo.sh` | The operator script: `setup`, `up`, `status`, `logs`, `backup`, `restore`, `update`, `deploy`, `rollback`, `deploys`, `autodeploy`, `down`, `compose` |
| `deploy.sh` | Deploys a commit: checks, build, start, health, rollback; automatic deploys from GitHub (`autodeploy`) |
| `lib.sh` | Helpers shared by both scripts (settings, compose, health waits, the lock) |
| `compose.yml` | The services: PostgreSQL 18 + pgvector, Valkey, the gateway (migrations, API, worker), Chatwoot 4.18.0-ce, ClamAV, the edge, and the deploy webhook receiver |
| `Caddyfile` | The edge: automatic HTTPS, the reverse proxies, Studio, the static widget and website, the widget's frame policy, and the deploy webhook route |
| `deploy-hook/hooks.yaml` | What the webhook receiver accepts: a signed push to the deploy branch of this repository |
| `systemd/` | The units `autodeploy enable` installs: the deploy service, its webhook trigger and its 5-minute timer |
| `env.example` | Every setting in `.env`, which `hamnivo.sh setup` writes with generated secrets |
| `chatwoot.env.example` | Optional Chatwoot settings, such as its email |
| `../docker/Dockerfile` | The images, built from this code: `gateway`, `edge`, `deploy-hook`, and `verify` (the checks a deploy runs) |

`.env`, `chatwoot.env`, `backups/` and `state/` (deploy history, logs and the lock) stay on the
server: git and Docker builds ignore them.

`bash scripts/ci/production-smoke.sh` deploys this stack on the current machine, using Caddy's
internal certificates, in its own compose project. It checks the deployment end to end, runs a
backup and restore drill, then deletes everything it created.

`bash scripts/ci/autodeploy-smoke.sh` tests automatic deploys the same way. A bare repository
stands in for GitHub. The test sends signed webhooks and deploys a good commit, then a commit
that fails its health checks (rolled back), then one that fails its unit tests (stopped before
anything restarts), and finally a manual rollback.
