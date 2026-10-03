import type {
  CreateIncidentRequest,
  Incident,
  PlatformAuditPage,
  PlatformHealth,
  PlatformOperator,
  PlatformOverview,
  PlatformTenant,
  PlatformTenantDetail,
} from '@hamnivo/contracts';
import {
  appendPlatformAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  schema,
  toPublicId,
} from '@hamnivo/db';
import { platformPermissions } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { iso } from '../common/views.js';
import type { AppConfig } from '../config.js';
import type { OperatorContext } from '../identity/request-auth.js';
import { supportGrantView } from '../support/views.js';
import { CLOCK, type Clock, CONFIG, PLATFORM_DB, REDIS } from '../tokens.js';

type TenantRow = {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'closing';
  region: string;
  default_locale: string;
  created_at: Date;
  workspaces: string;
  brands: string;
  connectors: string;
  unhealthy: string;
  ai_stops: string;
  providers_off: string;
  active_support: string;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}

/**
 * The platform operations console (A17), read through the hamnivo_platform database role:
 * tenants and their state, service health, AI stops and switched-off providers, support access
 * and incidents. It never reads tenant content; that needs an approved support grant.
 */
@Injectable()
export class PlatformService {
  constructor(
    @Inject(PLATFORM_DB) private readonly db: Db | null,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get platform(): Db {
    if (!this.db) throw new AppError('NOT_FOUND');
    return this.db;
  }

  me(operator: OperatorContext): z.infer<typeof PlatformOperator> {
    return {
      id: toPublicId('operator', operator.principal.operatorId),
      name: operator.name,
      email: operator.email,
      role: operator.principal.role,
      permissions: platformPermissions(operator.principal),
      mfa: operator.principal.mfa,
    };
  }

  private tenantQuery(where = sql`true`) {
    return this.platform.execute<TenantRow>(sql`
      select t.id, t.name, t.slug::text as slug, t.status, t.region, t.default_locale, t.created_at,
        (select count(*) from workspaces w where w.tenant_id = t.id) as workspaces,
        (select count(*) from brands b where b.tenant_id = t.id) as brands,
        (select count(*) from authority_connections c where c.tenant_id = t.id) as connectors,
        (select count(*) from authority_connections c
           where c.tenant_id = t.id and c.status in ('degraded', 'disabled')) as unhealthy,
        (select count(*) from kill_switches k
           where k.tenant_id = t.id and k.cleared_at is null and k.scope <> 'tool') as ai_stops,
        (select count(*) from model_connections m
           where m.tenant_id = t.id and m.status = 'disabled') as providers_off,
        (select count(*) from support_grants s
           where s.tenant_id = t.id and s.status = 'approved' and s.revoked_at is null
             and s.ended_at is null and s.expires_at > now()) as active_support
      from tenants t
      where ${where}
      order by t.name
      limit 200`);
  }

  private tenantView(row: TenantRow): z.infer<typeof PlatformTenant> {
    return {
      id: toPublicId('tenant', row.id),
      name: row.name,
      slug: row.slug,
      status: row.status,
      region: row.region,
      createdAt: new Date(row.created_at).toISOString(),
      workspaces: Number(row.workspaces),
      brands: Number(row.brands),
      connectors: { total: Number(row.connectors), unhealthy: Number(row.unhealthy) },
      aiStops: Number(row.ai_stops),
      providersOff: Number(row.providers_off),
      activeSupportGrants: Number(row.active_support),
    };
  }

  async tenants(query: string | undefined): Promise<z.infer<typeof PlatformTenant>[]> {
    const pattern = query ? `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const { rows } = await this.tenantQuery(
      pattern ? sql`(t.name ilike ${pattern} or t.slug::text ilike ${pattern})` : sql`true`,
    );
    return rows.map((row) => this.tenantView(row));
  }

  async tenant(publicId: string): Promise<z.infer<typeof PlatformTenantDetail>> {
    let tenantId: string;
    try {
      tenantId = fromPublicId('tenant', publicId);
    } catch (error) {
      if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
      throw error;
    }
    const { rows } = await this.tenantQuery(sql`t.id = ${tenantId}::uuid`);
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND');
    const db = this.platform;
    const workspaces = await db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        status: schema.workspaces.status,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.tenantId, tenantId));
    const brands = await db
      .select({ id: schema.brands.id, name: schema.brands.name, status: schema.brands.status })
      .from(schema.brands)
      .where(eq(schema.brands.tenantId, tenantId));
    const connectors = await db
      .select({
        id: schema.authorityConnections.id,
        kind: schema.authorityConnections.kind,
        status: schema.authorityConnections.status,
        lastHealthAt: schema.authorityConnections.lastHealthAt,
      })
      .from(schema.authorityConnections)
      .where(eq(schema.authorityConnections.tenantId, tenantId));
    const stops = await db
      .select({
        id: schema.killSwitches.id,
        scope: schema.killSwitches.scope,
        since: schema.killSwitches.createdAt,
      })
      .from(schema.killSwitches)
      .where(
        and(
          eq(schema.killSwitches.tenantId, tenantId),
          sql`${schema.killSwitches.clearedAt} is null`,
        ),
      );
    const providers = await db
      .select({
        provider: schema.modelConnections.provider,
        status: schema.modelConnections.status,
      })
      .from(schema.modelConnections)
      .where(eq(schema.modelConnections.tenantId, tenantId));
    const grants = await db
      .select()
      .from(schema.supportGrants)
      .where(eq(schema.supportGrants.tenantId, tenantId))
      .orderBy(desc(schema.supportGrants.requestedAt))
      .limit(20);
    const now = this.clock();
    return {
      ...this.tenantView(row),
      defaultLocale: row.default_locale,
      workspaceList: workspaces.map((w) => ({
        id: toPublicId('workspace', w.id),
        name: w.name,
        status: w.status,
      })),
      brandList: brands.map((b) => ({
        id: toPublicId('brand', b.id),
        name: b.name,
        status: b.status,
      })),
      connectorList: connectors.map((c) => ({
        id: toPublicId('connection', c.id),
        kind: c.kind,
        status: c.status,
        lastHealthAt: iso(c.lastHealthAt),
      })),
      // A tool switch stops one tool's actions, not replies: it is not an AI stop.
      aiStopList: stops.flatMap((s) =>
        s.scope === 'tool'
          ? []
          : [{ id: toPublicId('killSwitch', s.id), scope: s.scope, since: s.since.toISOString() }],
      ),
      providerList: providers,
      supportGrants: grants.map((g) =>
        supportGrantView(g, { id: tenantId, name: row.name }, null, now),
      ),
    };
  }

  async health(): Promise<z.infer<typeof PlatformHealth>> {
    const db = this.platform;
    const [database, valkey] = await Promise.allSettled([
      withTimeout(db.execute(sql`select 1`), 2000),
      withTimeout(this.redis.ping(), 2000),
    ]);
    let queue = { pending: 0, oldestSeconds: null as number | null, failing: 0 };
    let queueState: 'healthy' | 'degraded' | 'down' = 'healthy';
    try {
      const { rows } = await db.execute<{ pending: string; oldest: Date | null; failing: string }>(
        sql`select count(*) as pending, min(created_at) as oldest,
                   count(*) filter (where attempts >= 3) as failing
            from outbox_events where processed_at is null`,
      );
      const stats = rows[0];
      const oldest = stats?.oldest ? new Date(stats.oldest) : null;
      queue = {
        pending: Number(stats?.pending ?? 0),
        oldestSeconds: oldest
          ? Math.max(0, Math.round((this.clock().getTime() - oldest.getTime()) / 1000))
          : null,
        failing: Number(stats?.failing ?? 0),
      };
      if (queue.failing > 0 || (queue.oldestSeconds ?? 0) > 300) queueState = 'degraded';
    } catch {
      queueState = 'down';
    }
    const { rows: connectorRows } = await db.execute<{ status: string; n: string }>(
      sql`select status, count(*) as n from authority_connections group by status`,
    );
    const byStatus = new Map(connectorRows.map((r) => [r.status, Number(r.n)]));
    const connectors = {
      total: [...byStatus.values()].reduce((a, b) => a + b, 0),
      degraded: byStatus.get('degraded') ?? 0,
      disabled: byStatus.get('disabled') ?? 0,
    };
    const state = (result: PromiseSettledResult<unknown>) =>
      result.status === 'fulfilled' ? ('healthy' as const) : ('down' as const);
    return {
      checkedAt: this.clock().toISOString(),
      services: [
        { key: 'api', state: 'healthy' },
        { key: 'database', state: state(database) },
        { key: 'valkey', state: state(valkey) },
        { key: 'queue', state: queueState },
        { key: 'connectors', state: connectors.degraded > 0 ? 'degraded' : 'healthy' },
      ],
      queue,
      connectors,
      providers: [
        { provider: 'anthropic', configured: Boolean(this.config.ANTHROPIC_API_KEY) },
        { provider: 'openai', configured: Boolean(this.config.OPENAI_API_KEY) },
        { provider: 'google', configured: Boolean(this.config.GOOGLE_GENERATIVE_AI_API_KEY) },
        {
          provider: 'openai-compatible',
          configured: Boolean(this.config.OPENAI_COMPATIBLE_BASE_URL),
        },
      ],
    };
  }

  private incidentView(row: typeof schema.platformIncidents.$inferSelect): Incident {
    return {
      id: toPublicId('incident', row.id),
      title: row.title,
      message: row.message,
      severity: row.severity,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      resolvedAt: iso(row.resolvedAt),
    };
  }

  async incidents(): Promise<Incident[]> {
    const rows = await this.platform
      .select()
      .from(schema.platformIncidents)
      .orderBy(desc(schema.platformIncidents.startedAt))
      .limit(20);
    return rows.map((row) => this.incidentView(row));
  }

  async overview(): Promise<z.infer<typeof PlatformOverview>> {
    const { rows } = await this.platform.execute<{
      total: string;
      active: string;
      suspended: string;
      support_active: string;
      support_pending: string;
      ai_stops: string;
      providers_off: string;
    }>(sql`
      select
        (select count(*) from tenants) as total,
        (select count(*) from tenants where status = 'active') as active,
        (select count(*) from tenants where status = 'suspended') as suspended,
        (select count(*) from support_grants where status = 'approved' and revoked_at is null
           and ended_at is null and expires_at > now()) as support_active,
        (select count(*) from support_grants where status = 'pending') as support_pending,
        (select count(*) from kill_switches
           where cleared_at is null and scope <> 'tool') as ai_stops,
        (select count(*) from model_connections where status = 'disabled') as providers_off`);
    const counts = rows[0];
    return {
      tenants: {
        total: Number(counts?.total ?? 0),
        active: Number(counts?.active ?? 0),
        suspended: Number(counts?.suspended ?? 0),
      },
      activeSupportGrants: Number(counts?.support_active ?? 0),
      pendingSupportRequests: Number(counts?.support_pending ?? 0),
      aiStops: Number(counts?.ai_stops ?? 0),
      providersOff: Number(counts?.providers_off ?? 0),
      incidents: (await this.incidents()).filter((incident) => incident.status === 'active'),
    };
  }

  async declareIncident(
    operator: OperatorContext,
    input: z.output<typeof CreateIncidentRequest>,
  ): Promise<Incident> {
    return this.platform.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.platformIncidents)
        .values({
          title: input.title,
          message: input.message,
          severity: input.severity,
          createdBy: operator.principal.operatorId,
        })
        .returning();
      if (!row) throw new Error('incident not returned');
      await appendPlatformAudit(tx, {
        operatorId: operator.principal.operatorId,
        action: 'incident.declared',
        targetType: 'incident',
        targetId: toPublicId('incident', row.id),
        outcome: 'success',
        data: { title: row.title, severity: row.severity },
      });
      return this.incidentView(row);
    });
  }

  async resolveIncident(operator: OperatorContext, publicId: string): Promise<Incident> {
    let incidentId: string;
    try {
      incidentId = fromPublicId('incident', publicId);
    } catch {
      throw new AppError('NOT_FOUND');
    }
    return this.platform.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.platformIncidents)
        .where(eq(schema.platformIncidents.id, incidentId))
        .for('update');
      if (!current) throw new AppError('NOT_FOUND');
      if (current.status === 'resolved') return this.incidentView(current);
      const [row] = await tx
        .update(schema.platformIncidents)
        .set({
          status: 'resolved',
          resolvedAt: this.clock(),
          resolvedBy: operator.principal.operatorId,
        })
        .where(eq(schema.platformIncidents.id, incidentId))
        .returning();
      if (!row) throw new Error('incident not returned');
      await appendPlatformAudit(tx, {
        operatorId: operator.principal.operatorId,
        action: 'incident.resolved',
        targetType: 'incident',
        targetId: publicId,
        outcome: 'success',
        data: { title: row.title },
      });
      return this.incidentView(row);
    });
  }

  async audit(
    before: number | undefined,
    limit: number,
  ): Promise<z.infer<typeof PlatformAuditPage>> {
    const e = schema.platformAuditEvents;
    const rows = await this.platform
      .select({
        event: e,
        operatorName: schema.platformOperators.displayName,
        tenantName: schema.tenants.name,
      })
      .from(e)
      .leftJoin(schema.platformOperators, eq(schema.platformOperators.id, e.operatorId))
      .leftJoin(schema.tenants, eq(schema.tenants.id, e.tenantId))
      .where(before ? lt(e.seq, before) : undefined)
      .orderBy(desc(e.seq))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(({ event, operatorName, tenantName }) => ({
      seq: event.seq,
      occurredAt: event.occurredAt.toISOString(),
      operator: event.operatorId
        ? { id: toPublicId('operator', event.operatorId), name: operatorName ?? '' }
        : null,
      action: event.action,
      tenant: event.tenantId
        ? { id: toPublicId('tenant', event.tenantId), name: tenantName ?? '' }
        : null,
      target: event.targetType ? { type: event.targetType, id: event.targetId } : null,
      outcome: event.outcome,
      reason: event.reason,
      data: event.data,
    }));
    return { items, nextBefore: rows.length > limit ? (items.at(-1)?.seq ?? null) : null };
  }
}
