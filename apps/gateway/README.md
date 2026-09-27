# @hamnivo/gateway

The Hamnivo Gateway: one codebase, two processes, both built on NestJS 12 and Fastify 5.

| Process | Entry | Does |
|---|---|---|
| API | `src/main.api.ts` | REST API, staff sign-in at `/api/auth/*` (Better Auth), administration, OpenAPI at `/v1/openapi.json` and `/docs`, health, metrics |
| Worker | `src/main.worker.ts` | Outbox relay (at-least-once), BullMQ maintenance: audit partitions and expiry purge |

## Request pipeline

1. Fastify assigns a request id (`X-Request-Id`, or a new `req_…`).
2. Helmet sets the security headers. CORS allows only the Studio origin.
3. The Valkey-backed rate limit applies.
4. `StaffGuard` reads the Better Auth session and, for tenant routes, loads the person's grants in
   that tenant (`X-Hamnivo-Tenant`) on every request, so a revocation or suspension takes effect on
   the next request. It then checks the route permission with `@hamnivo/policy`:
   - MFA and a fresh sign-in are required where the catalog says so;
   - `tenantWide` routes need the permission at tenant scope.
5. The handler validates input with the contract schemas from `@hamnivo/contracts`.
6. All tenant data access goes through `withTenant()`, so PostgreSQL row-level security applies.
7. Every change writes a hash-chained audit event in the same transaction.
8. Errors become RFC 9457 problem details (`application/problem+json`) with a stable `code`.
   Malformed or foreign ids are `NOT_FOUND`.

## Security rules enforced here

- **Delegation ceiling (A03).** Grants and invitations may only hand out permissions the grantor
  holds, inside their own scope, and must expire no later than the grantor's own access. Custom roles
  may only contain permissions the editor holds tenant-wide.
- **Owners are protected.** The last owner cannot be revoked or suspended, and nobody can change
  their own access.
- **Credentials are write-only (A06, X04).** Secrets are envelope-encrypted with AES-256-GCM, bound
  to their tenant and row, and never returned or logged. Key-encryption-key rotation rewraps secrets
  lazily.
- **Invitations need a verified email.** The link carries a one-time secret compared in constant
  time, and the invitation must be accepted by the invited email address after server-side
  verification.
- **Idempotency.** `Idempotency-Key` replays the first response and refuses reuse with a different
  body (`IDEMPOTENCY_CONFLICT`). Retried tenant creation reuses a derived tenant id.

## Run

```bash
pnpm --filter @hamnivo/gateway build
pnpm --filter @hamnivo/gateway start:api      # or start:worker; reads ../../.env.local
```

## Test

```bash
pnpm --filter @hamnivo/gateway test           # unit
pnpm --filter @hamnivo/gateway test:int       # PostgreSQL + Valkey (services:up or ci:local)
```

The integration suites run the real HTTP stack in process (`app.inject`) against a cloned database.
They cover sign-up with email verification, TOTP enrolment and the second-factor sign-in, tenant
creation, invitations, delegation, revocation, step-up, secrets, KEK rotation and the worker.
