# Security policy

## Report a vulnerability privately

Please do not open a public issue, pull request or discussion for a security problem.

Report it through GitHub's private vulnerability reporting instead:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**, or go straight to
   <https://github.com/CodeWithJuber/Hamnivo/security/advisories/new>.
3. Describe the problem, the affected component and version or commit, how to reproduce it, and
   what an attacker could do with it.

Only you and the maintainers can read the report. We reply in the advisory, agree on a fix and a
disclosure date with you there, and credit you in the published advisory unless you ask us not to.

## Supported versions

Hamnivo is released from `main`. Fixes go to `main` only, so keep your installation up to date
(`hamnivo.sh update`, or automatic deploys: `docs/self-hosting.md`, A10).

| Version | Supported |
|---|---|
| `main` | yes |
| older commits | no: update to `main` |

The npm packages (`@hamnivo/react`, `@hamnivo/vue`) are fixed in their latest version.

## Scope

In scope: everything in this repository, including the gateway and worker, Studio, the chat widget
and its loader, the SDKs, the plugins in `integrations/`, and the deployment scripts in `deploy/`.

Out of scope, and better reported upstream:

- Chatwoot itself, which Hamnivo uses as its conversation store. Report it to the
  [Chatwoot project](https://github.com/chatwoot/chatwoot/security). If Hamnivo's use of Chatwoot
  makes it exploitable, report that here too.
- Vulnerabilities in a dependency. Report them to its maintainers, and tell us here if Hamnivo is
  affected in a way its own advisory does not cover.
- Findings that need a compromised server, a stolen staff session, or physical access to a device.

## Testing

Test against your own installation, never someone else's. Do not access, change or delete data
that is not yours, and do not run tests that degrade a service for other people.
