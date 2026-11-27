# ADR 0021: Public repository: CI on GitHub-hosted runners

- Status: accepted
- Date: 2026-11-26
- Supersedes: ADR 0019, ADR 0020
- Amends: ADR 0007, ADR 0009

## Context

The owner is publishing Hamnivo as an open-source repository, under the AGPL-3.0, with a
contributor licence agreement (`NOTICE`, `CLA.md`). That changes what CI costs and what it risks.

- **Cost.** GitHub's billing page (read on 2026-11-26) lists standard GitHub-hosted runners in
  public repositories as free, and measures minutes and storage against the plan only for private
  repositories. ADR 0020 kept CI on our own runner only so that GitHub would bill nothing for a
  private repository. Larger runners are billed, even for a public repository.
- **Risk.** A self-hosted runner on a public repository runs code from anyone's pull request on
  our own machine. Ours ran a privileged Docker-in-Docker daemon (ADR 0019), which ADR 0019 and
  ADR 0020 accepted only while the repository was private and only the owner and the agents they
  ran could push.
- **Coverage.** The runners shared one small server, so on 2026-11-26 CI stopped linting and
  stopped running the browser suites and the production smoke test (ADR 0009). Pull requests were
  not checked before they merged, apart from typecheck and unit tests on branch pushes.
- **Releases.** `release-packages.yml` published with a long-lived `NPM_TOKEN` secret and without a
  provenance statement, because npm gives provenance and trusted publishing only to GitHub-hosted
  runners.

## Decision

- **Every job runs on a standard GitHub-hosted runner**, `ubuntu-24.04`, named literally. There
  are no self-hosted labels, no heavy and fast runner split, and no `max-parallel` limit.
- **What CI runs** (`.github/workflows/ci.yml`, `scripts/ci/plan.mjs`). Every run lints (Biome and
  shellcheck).
  - A pull request to `main`: typecheck and unit tests on the packages its change reaches, the
    integration tests on PostgreSQL 18, and the other suites its change reaches in turbo's package
    graph: the Chatwoot contract suite, the accessibility audit, the widget journey, Studio in three
    parts and the website. A change to Markdown or `docs/` alone gets only the basics. It never runs
    a smoke test, since they build the production images. A newer push cancels the older run.
  - A push to `main` (a merge): the suites reached since the last commit a run passed on `main`
    (`--last-passed`), so a suite that failed runs again on the next merge; typecheck and unit
    tests on every package; and the production and automatic-deploy smoke tests when a deploy file
    changed.
  - Every Saturday at 23:00 UTC, and a run by hand: everything, on PostgreSQL 16 and 18, with both
    smoke tests.
  - A change the graph cannot place gets every suite (with the smoke tests only on `main`).
  - One job named `checks` passes only when every suite the plan picked passed, so a branch rule
    can require a single status.
  - This is the selection from before 2026-11-26, restored for pull requests instead of branch
    pushes. Branch pushes no longer run CI.
- **Caches and results.** setup-node caches pnpm's store. PostgreSQL, Valkey and Chatwoot still
  start in Docker from `pnpm ci:local`. Each suite's `test-results/` is an artifact kept 14 days,
  and the report goes into the run summary.
- **A guard instead of the billing check.** `scripts/ci/public-repo-guard.sh` replaces
  `no-github-billing.sh`. It runs first in CI and in `pnpm ci:local --quick`, and fails on:
  - a `runs-on` that is not one standard GitHub-hosted label (`ubuntu-*`, `windows-*`, `macos-*`
    with a version or `latest`): a self-hosted or larger runner, an expression, a variable or a
    runner group;
  - a `pull_request_target` workflow that checks out code or reads the pull request's head.
- **Workflow hardening.** Every action is pinned to a full commit SHA with its version in a
  comment. Every workflow starts with `permissions: contents: read`, and a job gets more only where
  it needs it. Every checkout sets `persist-credentials: false`. CI uses no `pull_request_target`.
  The CLA check (`cla.yml`) is the one exception: it must comment and set a status on pull requests
  from forks, never checks out code, and the guard keeps it so.
- **Security checks.** `security.yml`: dependency review on pull requests (high or critical
  advisories fail), gitleaks on the whole history with `.gitleaks.toml`, and `reuse lint`.
  `scorecard.yml`: OpenSSF Scorecard on pushes to `main` and weekly, published, with its findings in
  code scanning. CodeQL runs as GitHub's default setup, configured in the repository settings, not
  as a workflow. Dependabot proposes grouped npm and GitHub Actions updates weekly.
- **Releases** (`release-packages.yml`) use npm's trusted publishing: the job runs in the
  environment `npm` with `id-token: write`, pnpm packs the package and `npm publish --provenance`
  publishes it. There is no npm token. The job uses no dependency cache.
- **The self-hosted runner kit goes.** `deploy/ci-runner/` and its guide are removed.
  `pnpm ci:local` still runs every check on any machine.
- **Production deploys are unchanged** (ADR 0008). The server pulls `main` itself; a public
  repository needs no deploy key, and `deploy.sh` already uses one only when it cannot read the
  repository.

## Consequences

- CI costs nothing while it uses standard runners, and the guard fails a change that would add a
  self-hosted or larger runner. The Actions budget of $0 (ADR 0020) can stay, as a second net.
- Pull requests are checked before they merge, with lint and the browser suites. A run is slower
  to start than on an idle runner of our own, and each job installs its dependencies and browsers.
- A pull request from a fork runs with a read-only token and no secrets. GitHub asks a maintainer
  to approve the workflows of a first-time contributor before they run.
- A standard runner has 4 CPUs and 16 GB. CI sets `HAMNIVO_CI_CONCURRENCY=4` and
  `HAMNIVO_CI_HEAVY_CONCURRENCY=2` for it; if the unit tests or type checks run short of memory or
  time, these are the first values to change.
- The owner sets up, once, in the repository and on npm:
  - private vulnerability reporting, and CodeQL's default setup;
  - a rule for `main` that requires a pull request and the `checks` status;
  - the environment `npm`, and each package's trusted publisher on npmjs.com (repository
    `CodeWithJuber/Hamnivo`, workflow `release-packages.yml`, environment `npm`); the `NPM_TOKEN`
    secret can then be deleted;
  - the unprotected branch `cla-signatures`, where the CLA check records signatures.
- The runner that served this repository can be stopped and removed under Settings → Actions →
  Runners.
