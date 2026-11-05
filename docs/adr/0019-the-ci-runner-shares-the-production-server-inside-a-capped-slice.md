# ADR 0019: The CI runner shares the production server, inside a capped slice with its own Docker

- Status: accepted
- Date: 2026-11-05
- Amends: ADR 0009

## Context

ADR 0009 put the runner on a machine of its own for two reasons. The smoke tests build `hamnivo/*`
images with tags a deploy also uses, and the pipeline's load would slow the live service. No such
machine was set up. Every CI run from 2026-10-16 to 2026-11-05 waited in the queue and was
cancelled without running a step, and pull requests were merged on `pnpm ci:local` runs on a
laptop.

The owner chose the compute server, which already runs production and three other projects'
runners. On 2026-11-05 it had 16 GB of memory with about 4 GB available and 10.5 GB of swap in use.
The pipeline wants about 8 GB.

## Decision

- **A Docker of its own.** The runner runs in a container next to a Docker-in-Docker daemon
  (`deploy/ci-runner/`). The images, containers, ports and prunes of the checks live in that daemon,
  so a `hamnivo/*` tag the checks build never reaches the Docker that production deploys use.
  - The runner shares the daemon's network namespace, so ports the checks publish are on its
    localhost.
  - The work volume has the same path in both containers, so bind mounts resolve.
- **A capped slice.** Both containers, and every container the inner daemon starts, live in the
  systemd slice `hamnivo-ci.slice`.
  - It allows at most 3 CPUs and 4 GB, with no swap.
  - Its CPU and disk weight is 10, against production's default of 100.
  - When the checks run out of memory, the kernel kills a process inside the slice, not a
    production one.
- **Sized for the cap.** The containers are pinned to three cores, so Node, Vitest and Playwright
  size their worker pools for three CPUs. `HAMNIVO_CI_CONCURRENCY=2` makes `pnpm ci:local` pass
  `--concurrency=2` to turbo. Turbo has no variable for this, and elsewhere it keeps its default.
  - The first run, with turbo's default concurrency, was killed in typecheck at the 4 GB cap.
    Production was untouched: Studio kept answering in under 60 ms.
- **Credentials.** The runner registers once with a one-time token. It keeps its credentials in a
  folder only root can reach on the host. The runner's user id, 1001, belongs to another account
  there.

## Consequences

- The checks run slower than on a laptop, and a heavy step can still fail for lack of memory. Such
  a failure fails the run, not the live service.
  - Raise `MemoryMax` only after memory is freed on the server.
  - Or move the runner to its own machine, as ADR 0009 intended. `deploy/ci-runner/` works
    unchanged there.
- The inner daemon is privileged, so a job can still reach the host as root. That is acceptable
  for a private repository whose only pushers are the owner and the agents they run. Outside
  contributors would need a separate machine.
- Branch protection, which would make `main` wait for `checks`, needs a paid GitHub plan for a
  private repository. Until then, check that `checks` passed before merging.
