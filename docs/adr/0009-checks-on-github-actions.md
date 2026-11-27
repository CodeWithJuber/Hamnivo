# ADR 0009: The full pipeline runs on GitHub Actions, on a runner of our own

- Status: accepted; amended by ADR 0019 and ADR 0020 (no variable picks the runner any more), on
  2026-11-26 (no browser suites, lint or production smoke test in CI), and by ADR 0021 (GitHub-hosted
  runners for the public repository; lint, the browser suites and pull request checks are back)
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

GitHub's hosted runners never started jobs for this repository while it was private (ADR 0007).
The owner already ran a self-hosted runner for another project.

## Decision

- **Where the pipeline runs.** `.github/workflows/ci.yml` runs `pnpm ci:local` on every push, split
  into suites that run side by side, one job each (types and unit tests; integration, in three
  parts per PostgreSQL version; Chatwoot; the automatic-deploy smoke test).
  Each change gets its heavy suites once, on main after the merge. A push to another branch
  runs only typecheck and unit tests on the packages its change reaches, and nothing when an
  earlier run passed its tree. A push to main runs the integration and Chatwoot suites turbo's
  package graph reaches from what changed since the last commit a run passed on main
  (`scripts/ci/plan.mjs`), so a suite that failed on one merge runs again on the next, on
  PostgreSQL 18, and the typecheck and unit tests on every package. A change to Markdown or
  `docs/` alone runs only the basics; a merge outside the packages, or one the graph cannot place,
  runs every suite but the smoke test. Main does not trust a passed tree, since a branch passes on
  its quick checks. Every Saturday (23:00 UTC) and on a run by hand
  (`gh workflow run ci.yml --ref <branch>`) it runs every suite, tests PostgreSQL 16 and 18 and
  runs the automatic-deploy smoke test, which builds the images and so never runs on a push.
  (2026-11-25: branch pushes ran the heavy suites too, and used about 58% of all CI minutes; the
  full run was nightly, about 400 job-minutes each night.)
- **What CI does not run.** No browser suite (the accessibility audit, the widget journey, Studio
  in three parts, the website), no lint (Biome, shellcheck, also left out of
  `release-packages.yml`) and no production smoke test, whose last part drives Studio in Chromium.
  The test files stay, and `pnpm ci:local` still runs all of them by hand
  (`pnpm ci:local --with-production` for the production smoke test). (2026-11-26, the owner's
  decision: CI moved to a smaller server shared by several runners. Until then the browser suites
  ran on main after a merge, lint on main, weekly and by hand, and the smoke tests on a push to
  main that changed a deploy file.)
- **Which runner.** It runs on a self-hosted runner with the label `hamnivo`; the heavy suites also need the label `heavy`, which all but two of the runners have, so the plan and the basics never wait behind them. The repository
  variable `HAMNIVO_CI_RUNNER`, a JSON list of labels, can point it at other runners, hosted
  ones included.
- **Before a push.** Changes get only the fast checks: Biome, typecheck, unit tests and the
  integration tests of the changed area. Biome and shellcheck run only here, since CI does not
  lint; the browser suites and the production smoke test run only when someone runs
  `pnpm ci:local` by hand. The push and its pull request then wait on CI, and only what CI reports
  is fixed.
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
