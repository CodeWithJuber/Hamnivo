# ADR 0002 — Toolchain: ESM, TypeScript 6.0, NestJS 12, pinned dependencies

- Status: accepted (2026-09-26)
- Blueprint: §8, §25

## Decision

- Node 24 LTS in images; Node ≥22.12 supported for development. pnpm 10 workspaces + Turborepo.
- **TypeScript 6.0.3**, not 7.x: NestJS CLI 12 pins `~6.0.2` and typescript-eslint supports `<6.1`.
- The whole repository is ESM (`module: nodenext` for Node packages, `bundler` in Vite apps), because
  NestJS 12, Better Auth, AI SDK 7 and the TypeSafe SDK are ESM-only. Explicit `types`, no `baseUrl`.
- Biome 2.5 for lint and format. Vitest 5 (+ unplugin-swc to emit decorator metadata for NestJS).
- Exact versions are pinned; floating `latest` is not used. A license inventory is produced from the
  lockfile (`docs/licenses.md`) and checked in CI.
