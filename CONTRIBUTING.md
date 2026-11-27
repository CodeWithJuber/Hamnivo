# Contributing to Hamnivo

Thank you for helping. This page explains how to set up the code, run the checks, and send a
change.

- For a large change, open an issue first, so we can agree on the approach before you write it.
- Security problems are never reported in public: see [SECURITY.md](SECURITY.md).
- Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## The contributor licence agreement (CLA)

Before your first pull request can be merged, you sign the
[Contributor License Agreement](CLA.md). You keep the copyright in your work. The agreement lets
the owner distribute your contribution under the project's licence and under other licences,
including commercial ones, and change the project's licence later.

To sign, reply on your pull request with the sentence the **CLA** check asks for. You sign once,
for all your later pull requests. Every author of a commit in the pull request signs for
themselves.

## Licences

Hamnivo is AGPL-3.0-only. The SDKs, the widget loader, the plugins and integrations, and the
examples keep a permissive licence, because other people's software embeds them; [NOTICE](NOTICE)
lists those paths. A contribution to a path is under that path's licence.

[REUSE.toml](REUSE.toml) records the licence of every file. A new file needs nothing: it takes
the licence of its folder. If you add third-party material, say where it comes from in the pull
request, add it to `REUSE.toml` and `NOTICE`, and check with
[`reuse lint`](https://reuse.software/dev/#tool).

## Set up

You need Node.js 22.12 or later (24 LTS recommended), pnpm 10 (`corepack enable` picks the version
in `package.json`), Docker, openssl and git. shellcheck is optional: the checks use it when it is
installed.

```bash
pnpm install
bash scripts/setup/env.sh   # .env.local with generated passwords and secrets (never commit it)
pnpm services:up            # PostgreSQL 18 + pgvector and Valkey in Docker
pnpm db:migrate
```

Part B of [`docs/self-hosting.md`](docs/self-hosting.md) shows how to run the API, the worker,
Chatwoot, Studio, the widget and the website one by one.

## Run the checks

`pnpm ci:local` is the whole pipeline. CI runs the same script, split into parts. It runs each
part against throwaway containers with generated passwords, so your development data is never
touched.

| Command | What it runs |
|---|---|
| `pnpm ci:local --quick` | Install, lint (Biome and shellcheck), typecheck, unit tests, the workflow guard, the CI plan's tests, the deploy-script tests, and the feature-status and licence inventory checks |
| `pnpm ci:local --quick --affected` | The same, with typecheck and unit tests only for the packages your change reaches (compared with `origin/main`) |
| `pnpm ci:local` | Everything above, plus integration tests on PostgreSQL 16 and 18, the Chatwoot contract suite, the accessibility audit, and the widget, Studio and website in a browser |
| `PG_VERSIONS=18 pnpm ci:local` | Integration tests on one PostgreSQL version |
| `pnpm ci:local --skip-a11y` (or `--skip-chatwoot`, `--skip-e2e`, `--skip-widget`, `--skip-studio`, `--skip-site`, `--skip-integration`, `--skip-basics`, `--skip-lint`) | Everything except that part |
| `pnpm ci:local --shard=2/3` | The second of three parts of the integration tests and of Studio's browser tests |
| `pnpm ci:local --with-production` | Also builds the production images and deploys them on this machine, with a backup and restore drill |
| `pnpm ci:local --with-autodeploy` | Also tests automatic deploys: webhook, checks and rollback |

`pnpm ci:local --help` lists every option. The results are in `test-results/ci-local.md`.

To run the quick checks before every `git push`:

```bash
git config core.hooksPath .githooks
```

## Tests

- **Unit tests** (Vitest): `pnpm test`, or one package with `pnpm --filter @hamnivo/gateway test`.
- **Integration tests** need PostgreSQL and Valkey. `pnpm ci:local --skip-basics --skip-e2e
  --skip-a11y --skip-chatwoot` starts them, runs the tests and removes them.
- **Browser tests** (Playwright with axe audits) are in `apps/widget/e2e`, `apps/console/e2e` and
  `apps/site/e2e`. `pnpm ci:local` builds what they need and starts the services. Install the
  browsers once with `pnpm --filter @hamnivo/console exec playwright install --with-deps chromium webkit`.

A change comes with tests for what it changes. A bug fix comes with a test that fails without it.

## Send a change

1. Fork the repository and create a branch from `main`.
2. Make the change, with its tests and its documentation in the same pull request:
   - the guides in `docs/` and `apps/docs` when behaviour changes;
   - an architecture decision record in [`docs/adr/`](docs/adr/) for a decision that is hard to
     reverse;
   - `pnpm status` when a feature's status changes, and `pnpm licenses` when dependencies change.
3. Run `pnpm format` and at least `pnpm ci:local --quick --affected`.
4. Open a pull request against `main` and fill in the template.

CI checks every pull request on GitHub's runners: lint, types and unit tests, the integration
tests, and the suites your change reaches. A run by hand, a merge to `main` and the weekly run
check more ([ADR 0021](docs/adr/0021-public-repository-ci-on-github-hosted-runners.md)). A
maintainer reviews the change once the checks pass and the CLA is signed.

### Commits

- Keep each commit to one logical change.
- Write the subject in the imperative mood, under about 72 characters, with no full stop: "Let
  customers end a chat from the widget". A scope prefix is welcome where it helps:
  `fix(console): ...`, `test(widget): ...`, `ci: ...`.
- Use the body to explain why, not what. Refer to issues as `#123`.
- Never commit secrets, `.env` files or database dumps. CI scans the whole history with gitleaks.
