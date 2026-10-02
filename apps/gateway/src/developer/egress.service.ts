import {
  type EgressPolicy,
  hostAllowed,
  normalizeHostPattern,
  type Resolver,
} from '@hamnivo/adapters/net';
import type { EgressPolicy as EgressPolicyView, SetEgressHostsRequest } from '@hamnivo/contracts';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import type { EgressHostEntry } from '@hamnivo/db/schema';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

/** Replaces DNS resolution for outbound requests (tests only). */
export const EGRESS_RESOLVER = Symbol('EGRESS_RESOLVER');

/**
 * The tenant's network egress allowlist (X05) and the policy every outbound request made for the
 * tenant is sent under: public addresses only (checked on the address actually connected to),
 * HTTPS, and, when the tenant keeps a list, only the hosts on it. The server administrator's
 * trusted origins (EGRESS_TRUSTED_ORIGINS) are the only exception, and tenants cannot add any.
 */
@Injectable()
export class EgressService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(EGRESS_RESOLVER) private readonly resolver?: Resolver,
  ) {}

  private async row(tx: TenantTx) {
    const [row] = await tx.select().from(schema.egressPolicies).limit(1);
    return row ?? null;
  }

  /** The policy for a tenant's allowlist. */
  policy(hosts: readonly string[]): EgressPolicy {
    return {
      allowedHosts: hosts,
      trustedOrigins: this.config.EGRESS_TRUSTED_ORIGINS,
      requireHttps: true,
      ...(this.resolver ? { resolve: this.resolver } : {}),
    };
  }

  /** The tenant's current policy (inside its transaction). */
  async policyIn(tx: TenantTx): Promise<EgressPolicy> {
    const row = await this.row(tx);
    return this.policy((row?.hosts ?? []).map((entry) => entry.pattern));
  }

  /** Whether the tenant's allowlist lets a request reach this URL (trusted origins always pass). */
  allows(policy: EgressPolicy, url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (policy.trustedOrigins?.includes(parsed.origin)) return true;
    return hostAllowed(parsed.hostname, policy.allowedHosts);
  }

  private async view(tx: TenantTx): Promise<EgressPolicyView> {
    const row = await this.row(tx);
    const hosts = row?.hosts ?? [];
    const policy = this.policy(hosts.map((entry) => entry.pattern));
    const endpoints = await tx
      .select({ id: schema.webhookEndpoints.id, url: schema.webhookEndpoints.url })
      .from(schema.webhookEndpoints)
      .orderBy(asc(schema.webhookEndpoints.createdAt));
    return {
      mode: hosts.length === 0 ? 'any_public_host' : 'allowlist',
      hosts: hosts.map((entry) => ({
        pattern: entry.pattern,
        note: entry.note,
        createdAt: entry.createdAt,
      })),
      blockedEndpoints: endpoints
        .filter((endpoint) => !this.allows(policy, endpoint.url))
        .map((endpoint) => ({
          id: toPublicId('webhookEndpoint', endpoint.id),
          url: endpoint.url,
        })),
      version: row?.version ?? 0,
    };
  }

  async get(tenantId: string): Promise<EgressPolicyView> {
    return withTenant(this.db, { tenantId }, (tx) => this.view(tx));
  }

  async setHosts(
    principal: StaffPrincipal,
    input: z.output<typeof SetEgressHostsRequest>,
  ): Promise<EgressPolicyView> {
    const fields: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    const entries: EgressHostEntry[] = [];
    input.hosts.forEach((host, index) => {
      const pattern = normalizeHostPattern(host.pattern);
      if (!pattern) {
        fields.push({
          path: `hosts.${index}.pattern`,
          message:
            'Use a public host name such as hooks.example.com, or *.example.com for its subdomains.',
        });
        return;
      }
      if (seen.has(pattern)) return;
      seen.add(pattern);
      entries.push({ pattern, note: host.note ?? null, createdAt: '' });
    });
    if (fields.length > 0) throw new AppError('VALIDATION_FAILED', { fields });
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      async (tx) => {
        const current = await tx
          .select()
          .from(schema.egressPolicies)
          .for('update')
          .then((rows) => rows[0] ?? null);
        if ((current?.version ?? 0) !== input.version) {
          throw new AppError('VERSION_CONFLICT', {
            detail: 'Someone else changed the list of allowed hosts. Reload and try again.',
          });
        }
        const before = new Map((current?.hosts ?? []).map((entry) => [entry.pattern, entry]));
        const now = this.clock().toISOString();
        const hosts = entries.map((entry) => ({
          ...entry,
          createdAt: before.get(entry.pattern)?.createdAt ?? now,
        }));
        if (current) {
          await tx
            .update(schema.egressPolicies)
            .set({ hosts, version: current.version + 1, updatedBy: principal.staffMemberId })
            .where(eq(schema.egressPolicies.id, current.id));
        } else {
          await tx.insert(schema.egressPolicies).values({
            tenantId: principal.tenantId,
            hosts,
            updatedBy: principal.staffMemberId,
          });
        }
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'network.egress_updated',
          targetType: 'tenant',
          targetId: toPublicId('tenant', principal.tenantId),
          outcome: 'success',
          data: {
            added: hosts.map((h) => h.pattern).filter((p) => !before.has(p)),
            removed: [...before.keys()].filter((p) => !seen.has(p)),
            mode: hosts.length === 0 ? 'any_public_host' : 'allowlist',
          },
        });
        return this.view(tx);
      },
    );
  }
}
