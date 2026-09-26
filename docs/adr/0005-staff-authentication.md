# ADR 0005 — Staff authentication with Better Auth; authorization is product-owned

- Status: accepted (2026-09-26)
- Blueprint: §3, §8 "Identity", A02, A13, X01

## Decision

- Better Auth 1.7 (library, not a separate identity server): email + password (argon2), TOTP MFA
  (required for privileged grants), passkeys, session listing and revocation, fresh-session step-up
  for sensitive actions, generic OIDC for platform SSO and per-tenant OIDC providers.
- Authorization is not delegated to the auth library. `packages/policy` evaluates action, resource,
  tenant, scope and conditions from server-side grants; browser-supplied roles confer nothing.
- Customers never use staff auth. Widget sessions are separate short-lived ES256 tokens; verified
  customer identity comes only from a tenant-signed assertion.
- Staff reach Chatwoot's own UI through single-use SSO links after a fresh Hamnivo session.
