# Custom portals and customer email branding

Workspace administrators with `branding.manage` can save portal appearance and customer email
presentation under `/v1/admin/branding`. Reads require `branding.read`; writes require a fresh
sign-in. These are tenant-scoped settings; agency links never bypass client membership or grants.

A custom hostname has three independent gates: tenant DNS ownership, an explicit edge route,
and operator confirmation of working HTTPS. A saved domain is `pending`. Publishing its exact
`_hamnivo-portal.<hostname>` TXT challenge and pressing Verify makes it `verified`, not active.
The exact host must also be listed in `PORTAL_CUSTOM_HOSTS` to become `active`. That environment
setting is an **operator attestation** that routing and publicly trusted TLS were tested; the API
cannot independently certify the deployed edge. `routingReady` and `tlsReady` report that
attestation, not an automated certificate probe.

For the production Compose deployment:

1. Register the hostname in Studio. Set its DNS A/AAAA or CNAME to the production edge, publish
   the returned TXT challenge, and verify ownership in Studio. Keep the TXT record in DNS.
2. Generate an explicit site fragment from the repository root:
   `node scripts/portal-domain.mjs portal.customer.example > deploy/production/sites/portal.customer.example.caddy`.
   Never use a wildcard or catch-all domain. The generator rejects Caddy metacharacters.
3. Rebuild the edge image with this release. It includes a same-origin portal index at `/srv/portal`;
   JavaScript assets are shared with Studio. Restart/reload the edge so it imports the new file.
   Caddy obtains and renews the certificate using the existing TLS configuration.
4. Verify the public hostname resolves to the intended edge and a normal browser or
   `curl -I https://portal.customer.example` accepts its certificate without `-k`. At this stage
   the gateway correctly returns 404 because activation is not attested yet. Do not use
   `HAMNIVO_TLS=internal` for a public customer domain.
5. Add the exact hostname to `PORTAL_CUSTOM_HOSTS` in `deploy/production/.env` and recreate the
   API and worker containers. Reopen Studio domain settings and confirm `active`. Check
   `https://portal.customer.example/v1/branding`, email/password sign-in, sign-out, reset/verify
   links, workspace switching, and rejection for a user without client membership.

The fragment proxies `/v1/*` and `/api/auth/*` to the gateway on the same hostname. Its HTML
sets `hamnivo-api=self`; cookies are host-only, HTTPS, HTTP-only, and SameSite Lax. The gateway
uses a separate fixed-origin Better Auth configuration for each allowlisted, verified hostname.
It does not trust forwarded Host, wildcard origins, or tenant-provided redirect URLs. Sessions
are independent across domains. Existing canonical portal behavior remains unchanged.

Passkeys and enterprise SSO remain scoped to the canonical portal (their relying-party identity
and registered identity-provider callback are unchanged). Start those methods on the canonical
portal; they do not transfer a canonical cookie to the custom host. Email/password and TOTP
work directly on the custom portal. Captcha-enabled deployments must also authorize the new
hostname in their captcha provider.

Disabling a domain immediately makes public branding and authentication unavailable. The edge
checks the public branding gate for every request, so existing portal sessions cannot keep using
that hostname. Disable rotates the TXT challenge; reactivation requires publishing the new
challenge and verifying again. A subsequent failed DNS check revokes ownership; a transient
resolver outage retains prior proof. Verification is on demand, not an automated ownership
renewal service. Operators must monitor DNS and remove retired hosts from `PORTAL_CUSTOM_HOSTS`
and the edge fragment. Only verified ownership is globally unique: pending registrations cannot squat a hostname.
Transfer requires the existing owner to disable its domain, after which the new owner must prove
its own independent DNS challenge.

Only safe portal fields are public. Email settings, tenant identifiers and verification tokens are
never returned by host resolution. Tenant settings/domain rows have PostgreSQL RLS and global
verified-hostname uniqueness; the public resolver is a restricted security-definer function.

Customer transcripts, unread-reply alerts, ticket confirmations and ticket replies use the saved
sender display name, HTTPS logo and Reply-To address. Their HTML escapes all customer content.
The SMTP envelope and From address remain `MAIL_FROM`. This release does not authorize custom
sending addresses or claim SPF/DKIM/provider readiness from a portal TXT record. Set an actual
monitored Reply-To inbox when recipients should be able to reply; this does not create an inbound
email channel automatically.
