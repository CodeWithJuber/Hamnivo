import { randomBytes } from 'node:crypto';
import {
  type BrandingDomain,
  type BrandingSettings,
  DEFAULT_EMAIL_BRANDING,
  DEFAULT_PORTAL_BRANDING,
  PortalBranding,
  type UpdateBrandingRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import type { AppConfig } from '../config.js';
import { DNS_RESOLVER, type DnsResolver } from '../identity/sso/dns.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type DomainRow = typeof schema.brandingDomains.$inferSelect;
export function portalVerificationRecord(hostname: string, token: string) {
  return { name: `_hamnivo-portal.${hostname}`, value: `hamnivo-portal=${token}` };
}
export async function checkPortalDns(
  dns: DnsResolver,
  hostname: string,
  token: string,
): Promise<'verified' | 'not_found' | 'lookup_failed'> {
  const record = portalVerificationRecord(hostname, token);
  try {
    const answers = await dns.resolveTxt(record.name);
    return answers.some((chunks) => chunks.join('') === record.value) ? 'verified' : 'not_found';
  } catch (error) {
    return ['ENOTFOUND', 'ENODATA', 'ENODOMAIN', 'NXDOMAIN'].includes(
      String((error as { code?: unknown }).code),
    )
      ? 'not_found'
      : 'lookup_failed';
  }
}
/** Strictly parse Host, never forwarded headers supplied by the browser. */
export function portalHostname(host: string | undefined): string | null {
  if (!host || !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(host)) return null;
  try {
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

@Injectable()
export class BrandingService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>) {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }
  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    data: Record<string, unknown> = {},
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'branding',
      targetId: toPublicId('tenant', principal.tenantId),
      outcome: 'success',
      data,
    });
  }
  private domain(row: DomainRow): BrandingDomain {
    const ready = this.config.PORTAL_CUSTOM_HOSTS.includes(row.hostname);
    return {
      id: toPublicId('brandingDomain', row.id),
      hostname: row.hostname,
      status: row.disabledAt
        ? 'disabled'
        : row.verifiedAt
          ? ready
            ? 'active'
            : 'verified'
          : 'pending',
      verification: portalVerificationRecord(row.hostname, row.verificationToken),
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastCheckResult: row.lastCheckResult as BrandingDomain['lastCheckResult'],
      routingReady: ready,
      tlsReady: ready,
      createdAt: row.createdAt.toISOString(),
    };
  }
  private async settingsTx(tx: TenantTx): Promise<BrandingSettings> {
    const [settings] = await tx.select().from(schema.tenantBranding).limit(1);
    const domains = await tx
      .select()
      .from(schema.brandingDomains)
      .orderBy(asc(schema.brandingDomains.createdAt));
    return {
      portal: settings?.portal ?? DEFAULT_PORTAL_BRANDING,
      email: settings?.email ?? DEFAULT_EMAIL_BRANDING,
      domains: domains.map((row) => this.domain(row)),
    };
  }
  settings(principal: StaffPrincipal) {
    return this.tx(principal, (tx) => this.settingsTx(tx));
  }
  update(principal: StaffPrincipal, input: UpdateBrandingRequest) {
    return this.tx(principal, async (tx) => {
      await tx
        .insert(schema.tenantBranding)
        .values({ tenantId: principal.tenantId, ...input })
        .onConflictDoUpdate({
          target: schema.tenantBranding.tenantId,
          set: { ...input, updatedAt: this.clock() },
        });
      await this.audit(tx, principal, 'branding.updated');
      return this.settingsTx(tx);
    });
  }
  async register(principal: StaffPrincipal, hostname: string) {
    const canonical = [
      this.config.PUBLIC_API_ORIGIN,
      this.config.PUBLIC_CONSOLE_ORIGIN,
      this.config.PUBLIC_WIDGET_ORIGIN,
    ].map((origin) => new URL(origin).hostname);
    if (canonical.includes(hostname))
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'hostname', message: 'A platform hostname cannot be claimed.' }],
      });
    try {
      return await this.tx(principal, async (tx) => {
        const [row] = await tx
          .insert(schema.brandingDomains)
          .values({
            tenantId: principal.tenantId,
            hostname,
            verificationToken: randomBytes(32).toString('base64url'),
          })
          .returning();
        if (!row) throw new Error('domain not returned');
        await this.audit(tx, principal, 'branding.domain_registered', { hostname });
        return this.domain(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'branding_domains_hostname_key'))
        throw new AppError('VALIDATION_FAILED', {
          fields: [
            { path: 'hostname', message: 'This hostname is already registered in this workspace.' },
          ],
        });
      throw error;
    }
  }
  private id(publicId: string) {
    try {
      return fromPublicId('brandingDomain', publicId);
    } catch {
      throw new AppError('NOT_FOUND');
    }
  }
  verify(principal: StaffPrincipal, publicId: string) {
    const id = this.id(publicId);
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.brandingDomains)
        .where(eq(schema.brandingDomains.id, id))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND');
      const result = await checkPortalDns(this.dns, row.hostname, row.verificationToken);
      const now = this.clock();
      const [updated] = await tx
        .update(schema.brandingDomains)
        .set({
          lastCheckedAt: now,
          lastCheckResult: result,
          // A missing record revokes trust. A resolver outage retains existing proof but cannot enable a disabled domain.
          verifiedAt: result === 'verified' ? now : result === 'not_found' ? null : row.verifiedAt,
          disabledAt: result === 'verified' ? null : row.disabledAt,
        })
        .where(eq(schema.brandingDomains.id, id))
        .returning();
      if (!updated) throw new Error('domain not returned');
      await this.audit(tx, principal, 'branding.domain_checked', {
        hostname: row.hostname,
        result,
      });
      return this.domain(updated);
    }).catch((error: unknown) => {
      if (isUniqueViolation(error, 'branding_domains_verified_key'))
        throw new AppError('VALIDATION_FAILED', {
          fields: [
            {
              path: 'hostname',
              message:
                'This hostname is already verified by another workspace. The current owner must disable it before transfer.',
            },
          ],
        });
      throw error;
    });
  }
  disable(principal: StaffPrincipal, publicId: string) {
    const id = this.id(publicId);
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .update(schema.brandingDomains)
        .set({
          disabledAt: this.clock(),
          verifiedAt: null,
          verificationToken: randomBytes(32).toString('base64url'),
        })
        .where(eq(schema.brandingDomains.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND');
      await this.audit(tx, principal, 'branding.domain_disabled', { hostname: row.hostname });
      return this.domain(row);
    });
  }
  async resolve(hostname: string): Promise<PortalBranding | null> {
    if (!this.config.PORTAL_CUSTOM_HOSTS.includes(hostname)) return null;
    const result = await this.db.execute<{ portal: unknown }>(
      sql`select portal from app.resolve_portal_branding(${hostname})`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return row.portal === null ? DEFAULT_PORTAL_BRANDING : PortalBranding.parse(row.portal);
  }
  async isActiveOrigin(origin: string): Promise<boolean> {
    try {
      const url = new URL(origin);
      return (
        url.origin === origin &&
        url.protocol === 'https:' &&
        !url.port &&
        !url.username &&
        !url.password &&
        (await this.resolve(url.hostname)) !== null
      );
    } catch {
      return false;
    }
  }
  async publicBranding(host: string | undefined) {
    const hostname = portalHostname(host);
    const canonical = [this.config.PUBLIC_API_ORIGIN, this.config.PUBLIC_CONSOLE_ORIGIN].map(
      (origin) => new URL(origin).hostname,
    );
    if (hostname && canonical.includes(hostname))
      return { portal: DEFAULT_PORTAL_BRANDING, customDomain: false };
    const portal = hostname ? await this.resolve(hostname) : null;
    if (!portal) throw new AppError('NOT_FOUND');
    return { portal, customDomain: true };
  }
}
