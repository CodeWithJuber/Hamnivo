# ADR 0020: The checks run on a server of our own, and GitHub bills nothing for them

- Status: superseded by ADR 0021 (the repository is public, and CI runs on GitHub-hosted runners)
- Date: 2026-11-21
- Amends: ADR 0009, ADR 0019

## Context

The owner wants GitHub to bill nothing for this repository. On 2026-11-21, GitHub's billing pages
said the following.

What GitHub bills for:

- **Hosted runners**, by the minute. The free plan includes $12 of compute a month.
- **Artifact storage**, 500 MB on the free plan, shared with GitHub Packages.
- **Cache storage** past 10 GB per repository.
- **Code Security (CodeQL)** on a private repository.

What is free:

- **Self-hosted runners.** GitHub announced a $0.002 a minute charge for them from
  2026-03-01, then postponed it without a new date. Its billing page lists self-hosted runners
  as usage that "remains free".
- **Job logs and job summaries.** They do not count as artifact storage.

The pipeline already ran on our own runner, with the dependency caches of the setup actions off
and the reports kept on the runner (2026-11-17). Two gaps were left:

- `release-packages.yml` read its runner from the variable `HAMNIVO_CI_RUNNER`, which ADR 0009
  let point at GitHub's hosted runners.
- Nothing stopped a later change from adding an artifact upload, a cache or `ubuntu-latest`.

The runner also shared the production server inside a capped slice (ADR 0019). The owner now had
a server for it alone.

## Decision

- **Every job runs on our own runner, named literally.** Both workflows say
  `runs-on: [self-hosted, linux, x64, hamnivo]`. `HAMNIVO_CI_RUNNER` is gone, so no variable can
  send a job to GitHub's runners.
- **Nothing goes to GitHub's storage.** There is no artifact upload, no `actions/cache`, no cache
  input on a setup action and no GitHub Packages.
  - Dependencies: pnpm's store sits on the runner's work volume (`npm_config_store_dir`), so a
    run links packages instead of downloading them. The run prunes the store to what it used.
  - Browsers and other tool caches: on the runner-cache volume.
  - Docker images and build cache: on the inner daemon's volume.
  - Results: each run's `test-results/` becomes a file in `/opt/hamnivo-ci-runner/results` on the
    server, kept 14 days (`HAMNIVO_CI_RESULTS_DAYS`). The run summary shows the report and the
    file's path.
- **A check keeps it so.** `scripts/ci/no-github-billing.sh` is a step of `pnpm ci:local`, quick
  runs included. It fails on:
  - a `runs-on` without `self-hosted`, or with an expression, a variable or a runner group;
  - an artifact upload or download;
  - `actions/cache`, a cache input, `package-manager-cache` other than false, or `type=gha`;
  - GitHub Packages, CodeQL, or a reusable workflow from another repository.
- **The runner moves to a server of its own.** `deploy/ci-runner/install.sh` sets it up on that
  server:
  - It installs Docker from Docker's repository and copies `deploy/ci-runner` to
    `/opt/hamnivo-ci-runner`.
  - It sizes `hamnivo-ci.slice` and turbo's concurrency to the machine: every core, and all the
    memory but a tenth or at least 1 GB. It writes those sizes to `.env`.
  - It registers the runner with a one-time token it asks for in the terminal, and starts it.
  - The image is GitHub's own runner image, which updates itself, as GitHub requires.
  - Without `.env`, `compose.yaml` keeps ADR 0019's sizes, so the capped setup on the production
    server still works.
  - On a server that runs other repositories' runners too, a shared runner kit runs this one
    instead, under one cap for all of them. `archive-results.sh` then writes to the kit's
    `CI_RESULTS_DIR`.
- **A budget makes it certain.** The owner sets an Actions budget of $0 under Settings → Billing
  and licensing → Budgets and alerts, with "Stop usage when budget limit is reached". A
  mistake can then fail a job, but never bill one.

## Consequences

- GitHub bills nothing while the repository uses only these workflows, and the check fails a
  change that would make it bill.
- A run whose runner is offline waits in the queue, which is free. GitHub fails a job that has
  waited 24 hours.
- Results are read on the server (`scp`), not downloaded from the run's page.
- If GitHub ever charges for self-hosted minutes, this ADR has to be revisited: the checks would
  then move off GitHub Actions entirely, to a runner the server triggers from the push webhook
  it already receives (ADR 0008).
- The inner Docker daemon is still privileged (ADR 0019). That is acceptable only while the
  repository is private and its only pushers are the owner and the agents they run.
