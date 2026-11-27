# ADR 0007: Self-hosted verification instead of hosted CI

- Status: accepted; amended by ADR 0009 (the same pipeline now also runs on GitHub Actions) and
  ADR 0021 (on GitHub-hosted runners, once the repository became public)
- Date: 2026-09-26

## Context

The repository was private then. GitHub Actions jobs never started: runners were never assigned, so the
jobs produced no logs and billed 0 ms. The owner chose to run checks and host services on their own
server instead of using GitHub Actions.

## Decision

- No hosted CI workflow is kept in the repository.
- `scripts/ci/local.sh` (`pnpm ci:local`) is the single verification pipeline:
  - install with a frozen lockfile, Biome, typecheck, unit tests, feature-status and licence checks;
  - integration tests against throwaway PostgreSQL 16 and 18 (+pgvector) and Valkey containers
    with random passwords;
  - the Storybook accessibility audit.
- Database roles and databases come from one bootstrap, `deploy/postgres/init.sh`. Development,
  checks and hosting all use it.
- Passwords are generated per installation into `.env.local` by `scripts/setup/env.sh`. Nothing
  secret is committed.
- An optional pre-push hook runs the quick checks.

## Consequences

- Pull requests show no automatic checks. The `test-results/ci-local.md` summary is attached to
  the review instead.
- Anyone with Docker and Node can reproduce the full pipeline exactly.
- If hosted CI is wanted later, the workflow only needs to call `scripts/ci/local.sh`.
