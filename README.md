<p align="center">
  <img src="packages/brand/source/hamnivo-logo.png" alt="Hamnivo" width="360">
</p>

<p align="center"><strong>Conversations, people and agents in one place.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue" alt="License: AGPL-3.0-only"></a>
  <a href="https://github.com/CodeWithJuber/Hamnivo/actions/workflows/ci.yml"><img src="https://github.com/CodeWithJuber/Hamnivo/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/CodeWithJuber/Hamnivo"><img src="https://api.scorecard.dev/projects/github.com/CodeWithJuber/Hamnivo/badge" alt="OpenSSF Scorecard"></a>
</p>

Hamnivo is an open-source, self-hosted, embeddable and API-first conversation platform. Customers,
human staff and scoped AI specialists work in the same conversation: AI answers from cited
knowledge, hands off to a person on request, proposes actions that need explicit approval, and
records what actually happened.

> **Status: under active development.** Capabilities are tracked per feature ID in
> [`docs/feature-status.md`](docs/feature-status.md). A feature is only marked implemented when it
> has code and tests; mockups and plans are not evidence.

## What is in this repository

| Surface | Path | Purpose |
|---|---|---|
| Hamnivo Chat | `apps/widget`, `packages/widget-loader` | Customer widget: one-script install, isolated iframe, RTL, accessible |
| Hamnivo Studio | `apps/console` | Agent workspace (inbox, lanes, handoff), AI agent studio, knowledge, admin, platform console |
| Hamnivo Gateway | `apps/gateway` | Public REST API + SSE, Chatwoot connector, AI runtime, workers |
| Hamnivo Connect | `packages/client`, `packages/react`, `packages/ui-react`, `packages/server-sdk` | Headless SDK, React bindings, server SDK |
| Hamnivo Connect for servers | `packages/server-sdk` (`@hamnivo/server`) | Signs the identity assertions that verify a website's signed-in customers ([guide](docs/guides/identity.md), [examples](examples)) and checks signed webhooks ([guide](docs/guides/webhooks.md)) |
| Developer platform | `apps/gateway/src/developer`, Studio → Developer | API keys for servers ([guide](docs/guides/api-keys.md)), signed webhooks with retries and replays, allowed outbound hosts |
| Website | `apps/site` | Public site |

Conversation storage is delegated to **Chatwoot Community Edition** (v4.18.0) through a narrow
adapter (`ConversationAuthorityPort`). Hamnivo owns identity, permissions, AI execution, approvals,
receipts, knowledge, memory, commerce and audit — never a second copy of the transcript. See
[`docs/adr/0001-chatwoot-conversation-authority.md`](docs/adr/0001-chatwoot-conversation-authority.md).

## Architecture at a glance

```
Host site ─ loader ─ iframe (Hamnivo Chat) ─┐                     ┌─ Chatwoot CE (conversation authority)
Hamnivo Studio / Copilot ───────────────────┼─► Hamnivo Gateway ──┤
Server SDK / REST / webhooks ───────────────┘   (NestJS, SSE)     └─ browser never calls Chatwoot directly
                        PostgreSQL + pgvector · Valkey/BullMQ · LiveKit ─ Worker (AI runs, sync, ingestion, …)
```

Design principles, carried into code and tests:

- **Verification before confident claims** — answers cite the evidence actually retrieved; uncertainty is shown.
- **Permissions before actions** — every tool call rechecks identity, ownership, grants and approval at execution.
- **Evidence before automation** — an action is complete only with an authoritative receipt; unknown stays unknown.
- **Recovery before release** — drafts survive failures, sends are idempotent, takeovers fence stale AI output.

## Start here

**New to Hamnivo?** Start with the **documentation**, written for non-technical business owners: it covers everything you need to get running. Every Hamnivo server serves it at `https://<your domain>/docs/`, and its pages are in [`apps/docs/src/content/docs/`](apps/docs/src/content/docs/index.md).

For an overview, see [`docs/using-hamnivo.md`](docs/using-hamnivo.md): it explains which app to use and what each one does.

## Quick start

Requirements: Node ≥ 22.12 (24 LTS recommended), pnpm 10, Docker and openssl. Everything runs on
your own machine or server. The full guide is [`docs/self-hosting.md`](docs/self-hosting.md).

```bash
git clone https://github.com/CodeWithJuber/Hamnivo.git && cd Hamnivo
pnpm install
bash scripts/setup/env.sh   # .env.local with generated passwords and secrets (never commit it)
pnpm services:up            # PostgreSQL 18 + pgvector and Valkey via Docker Compose
pnpm db:migrate             # schema, row-level security, audit partitions
pnpm ci:local               # every check: lint, types, unit, integration (PG 16 + 18), accessibility
```

To run Hamnivo in production on your own server, with HTTPS and backups:

```bash
./deploy/production/hamnivo.sh setup --domain example.com --email you@example.com
./deploy/production/hamnivo.sh up
```

The steps, from DNS records to backups and updates, are in Part A of
[`docs/self-hosting.md`](docs/self-hosting.md).

Not sure which app to open? [`docs/using-hamnivo.md`](docs/using-hamnivo.md), "Which app do I
use?", explains it: your team works in Hamnivo Studio, and Chatwoot is only the engine underneath.

Further guides live in [`docs/`](docs/). The feature backlog and architecture diagrams are in
[`docs/blueprint/`](docs/blueprint/), and the UI/UX design kit is in [`docs/design/`](docs/design/).

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) explains the setup, the checks and
the commit style. Before your first pull request is merged, you sign the
[Contributor License Agreement](CLA.md) once, by replying on the pull request. Everyone who takes
part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Every pull request is checked by CI on GitHub's runners: lint, types, unit and integration tests,
and the browser suites the change reaches.

## Security

Please report vulnerabilities privately, through
[GitHub's private vulnerability reporting](https://github.com/CodeWithJuber/Hamnivo/security/advisories/new),
never in a public issue. See [`SECURITY.md`](SECURITY.md).

## License

Copyright (C) 2026 Juber Shaikh (Hostlelo).

Hamnivo is free software under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only). If you run a modified version for other people over a network, the licence asks you
to offer them its source code.

Code that runs inside other people's software keeps a permissive licence: the SDKs, the React and
Vue bindings, the widget loader, the plugins and integrations, and the examples are MIT (the Google
Tag Manager template is Apache 2.0). [`NOTICE`](NOTICE) lists them, and
[`REUSE.toml`](REUSE.toml) records the licence of every file. Third-party components keep their own
licences; see [`NOTICE`](NOTICE) and [`docs/licenses.md`](docs/licenses.md).
