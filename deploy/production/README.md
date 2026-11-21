# Hamnivo in production

Everything needed to run Hamnivo on one server with Docker. The step-by-step guide, from DNS
records to backups and updates, is Part A of [`docs/self-hosting.md`](../../docs/self-hosting.md).

```bash
./deploy/production/hamnivo.sh setup --domain example.com --email you@example.com
./deploy/production/hamnivo.sh up
```

| File | What it is |
|---|---|
| `hamnivo.sh` | The operator script: `setup`, `up`, `status`, `doctor`, `logs`, `mail`, `backup`, `backup-check`, `backups`, `restore`, `update`, `deploy`, `rollback`, `deploys`, `autodeploy`, `down`, `compose` |
| `deploy.sh` | Deploys a commit: HTTPS check, checks, build, start, health, rollback; automatic deploys from GitHub (`autodeploy`) |
| `doctor.sh` | `hamnivo.sh doctor`: checks the server (services, HTTPS for every name, ports, disk, memory, certificates, deploys) and says how to fix what is wrong. Only reads |
| `lib.sh` | Helpers shared by the scripts (settings, compose, health waits, HTTPS checks, the lock) |
| `compose.yml` | The services: PostgreSQL 18 + pgvector, Valkey, the gateway (migrations, API, worker), Chatwoot 4.18.0-ce, ClamAV, the edge, and the deploy webhook receiver |
| `Caddyfile` | The edge: automatic HTTPS, the reverse proxies, Studio, the static widget and website, the widget's frame policy, and the deploy webhook route |
| `deploy-hook/hooks.yaml` | What the webhook receiver accepts: a signed push to the deploy branch of this repository |
| `systemd/` | The units `autodeploy enable` installs (the deploy service, its webhook trigger and its 5-minute timer) and those `backups on` installs (a backup every night, a backup check every month) |
| `env.example` | Every setting in `.env`, which `hamnivo.sh setup` writes with generated secrets, and the deploy settings |
| `chatwoot.env.example` | Optional Chatwoot settings, such as its email |
| `../docker/Dockerfile` | The images, built from this code: `gateway`, `edge`, `deploy-hook`, and `verify` (the checks a deploy runs) |

`.env`, `chatwoot.env`, `backups/` and `state/` (deploy history, logs and the lock) stay on the
server: git and Docker builds ignore them.

`bash scripts/ci/production-smoke.sh` deploys this stack on the current machine, using Caddy's
internal certificates, in its own compose project. It checks the deployment end to end, runs a
backup and restore drill, then deletes everything it created.

`bash scripts/ci/deploy-https-test.sh` checks `doctor` and the HTTPS rules of deploys (a stop before
building, one edge restart, the reason in the log, the history and GitHub) in under a minute. It
needs no Docker: stand-ins for `docker`, `curl`, `ss` and `systemctl` answer instead.

`bash scripts/ci/autodeploy-smoke.sh` tests automatic deploys the same way, with a bare
repository standing in for GitHub. It checks the webhook's answers through Caddy, then pushes
commits:
- a good one;
- one with a migration that fails its health checks, which is backed up, then rolled back;
- one that fails its unit tests, stopped before anything restarts;
- a manual rollback;
- a new version of other software, held for a deploy by hand;
- an update after a `git pull` by hand.
