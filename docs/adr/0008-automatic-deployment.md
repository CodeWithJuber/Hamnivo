# ADR 0008: Automatic deployment from GitHub without hosted CI

- Status: accepted
- Date: 2026-09-27

## Context

The owner asked for automatic deployment from GitHub to their own server. ADR 0007 already rules
out GitHub Actions, hosted or self-hosted runners alike. The owner chose:
- every push to `main` deploys;
- GitHub reaches the server through a webhook, with polling as a backup;
- build, lint, type checks and unit tests must pass on the server before a version goes live;
- health checks, with automatic rollback.

Two facts about GitHub webhooks shape the design. GitHub waits 10 seconds for an answer, and it
never delivers a failed webhook again by itself.

`hamnivo.sh update` (a pull, a rebuild of the mutable `:local` tag, then a restart) was not safe
to run unattended:
- no lock, so a webhook and a timer could overlap;
- no rollback;
- the running script replaced itself during the pull;
- no credentials for the private repository;
- a full rebuild, and 1.5 GB of build cache, on every change.

## Decision

- **A small receiver.** `deploy-hook` is adnanh/webhook (the Debian package), running in a
  locked-down container.
  - It accepts `POST https://api.<domain>/_deploy/github` only with a valid HMAC-SHA256 signature
    (`X-Hub-Signature-256`).
  - It accepts only a push to the deploy branch of the configured repository, or GitHub's ping.
  - On a match it only creates a file in `state/requests/`. The server then fetches from GitHub
    itself, so no request content reaches a shell.
  - Caddy routes to it only while `HAMNIVO_AUTODEPLOY=webhook`.
- **systemd on the host runs the deploy.**
  - `hamnivo-deploy.path` starts `hamnivo-deploy.service` when a request is waiting.
  - `hamnivo-deploy.timer` starts it every 5 minutes, which covers lost webhooks and servers
    without a public address.
  - `ExecStartPre` empties the request folder, because systemd re-checks a path unit the moment
    its service ends, even after a failure.
- **One runner, `deploy/production/deploy.sh`**, also used by hand through `hamnivo.sh
  update | deploy | rollback`:
  - It takes a lock and fetches the branch. Private GitHub repositories use a read-only deploy key,
    with GitHub's published host key pinned.
  - It checks out the target, then runs that version's own `hamnivo.sh` phases:
    1. `setup --quiet`;
    2. the Docker `verify` target (Biome, type checks, unit tests);
    3. images tagged with the commit and labelled with its revision;
    4. a backup when migrations change;
    5. `up`, then the health checks and an HTTPS probe through the edge.
  - A failure before the start touches nothing that runs. A failure after it starts the previous
    version again.
  - Failed commits are not retried automatically.
  - GitHub deployment statuses are reported when a fine-grained token (Deployments: write) is
    configured.
- **Builds are incremental.**
  - Dependencies are installed from the package manifests before the source is copied, so a code
    change reuses them.
  - Turbo's cache lives in a BuildKit cache mount, so unchanged packages are neither rebuilt nor
    retested.
  - The build cache is capped by size.
- **The runner's safety net.** It is written as functions, called from one final line
  (`main "$@"; exit`), so bash has read the whole file before a checkout replaces it.

## Consequences

- Merging to `main` puts that commit live within minutes. `main` must be protected on GitHub.
- **Builds run on the production server.**
  - A deploy costs CPU for a few minutes: seconds when nothing changed, minutes for a full build.
  - The checks run without services. Integration tests, browser tests and the Chatwoot contract
    suite stay in `pnpm ci:local`, which is run before merging.
- **Rollback only swaps images and compose files; the database stays as migrated.**
  - Migrations must therefore stay backward compatible for one release: add first, remove later.
  - The automatic pre-deploy backup covers the exceptions.
- **A restart interrupts service briefly.**
  - Caddy holds API and Chatwoot requests for up to 20 s while they restart.
  - Open live streams reconnect.
  - The edge itself restarts in about a second.
- **Deploy history lives in two places:** on the server (`hamnivo.sh deploys`, logs under
  `state/logs/`) and, with a token, on GitHub.

## Alternatives considered

- **GitHub Actions**, hosted or on a self-hosted runner: ruled out by ADR 0007 and by the owner.
- **Coolify or Dokploy:** they bring their own proxy (Traefik) and deploy model. That would
  replace the Caddy edge, which sets per-brand frame policies, and its health-gated rollbacks.
- **Kamal:** it deploys from another machine, and needs a registry and something to trigger it.
- **Watchtower:** it needs images built elsewhere and pushed to a registry, and it cannot run the
  checks or roll back on failed health.
- **docker-rollout, for zero-downtime API restarts:** possible later. Caddy's `lb_try_duration`
  already hides most restarts.
