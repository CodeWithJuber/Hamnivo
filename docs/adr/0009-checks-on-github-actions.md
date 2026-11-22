# ADR 0009: The full pipeline runs on GitHub Actions, on a runner of our own

- Status: accepted; amended by ADR 0019 and ADR 0020 (no variable picks the runner any more)
- Date: 2026-10-02
- Amends: ADR 0007

## Context

Under ADR 0007 every change was verified by running `pnpm ci:local` before it was pushed. This
was done on the development machine or by the AI agents that build Hamnivo. The browser suites,
the integration tests on two PostgreSQL versions, and the production and deploy smoke tests take
45 to 60 minutes.

The agents spent most of their effort waiting for those runs, not writing code. Each check on a
waiting run re-reads the whole conversation. A few hours of parallel work used hundreds of
millions of tokens, nearly all of it on this. The machine's time costs little; the agents' does.

GitHub's hosted runners never started jobs for this private repository (ADR 0007). The owner
already runs a self-hosted runner for another project.

## Decision

- **Where the pipeline runs.** `.github/workflows/ci.yml` runs `pnpm ci:local` on every push, split
  into suites that run side by side, one job each (lint, types and unit tests; integration, in
  three parts per PostgreSQL version; Chatwoot; the accessibility audit; the widget journey;
  Studio, in three parts; the website; the production and automatic-deploy smoke tests).
  On main and on a run by hand it tests PostgreSQL 16 and 18 and runs the smoke tests; other
  branches test PostgreSQL 18 only and run the smoke tests only when a deploy file changes.
  A push of a tree that an earlier run already passed is not checked again: main then runs only
  PostgreSQL 16 and the smoke tests, other branches nothing. A run by hand runs everything.
- **Which runner.** It runs on a self-hosted runner with the label `hamnivo`. The repository
  variable `HAMNIVO_CI_RUNNER`, a JSON list of labels, can point it at other runners, hosted
  ones included.
- **Before a push.** Changes get only the fast checks: Biome, typecheck, unit tests and the
  integration tests of the changed area. The push and its pull request then wait on CI, and only
  what CI reports is fixed.
- **`pnpm ci:local` stays the single pipeline.** CI calls it, and a server can still run it by
  hand. Database bootstrap and generated passwords are unchanged from ADR 0007.
- **Where the runner lives.** It runs on its own machine, not on the production server. Its
  smoke tests build `hamnivo/*` images with tags that a deploy also uses, and its load would slow
  the live service.

## Consequences

- Pull requests show a `checks` status, and its summary is kept as the `ci-results` artifact.
- Until a runner with the `hamnivo` label is registered, runs wait in the queue. They cost
  nothing.
- A change can reach a pull request before the heavy suites have run on it. `main` still only
  gets changes that pass, as long as the `checks` status is required before merging.
