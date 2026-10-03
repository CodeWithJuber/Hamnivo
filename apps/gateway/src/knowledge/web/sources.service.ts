import { checkDestination, EgressError } from '@hamnivo/adapters/net';
import type {
  CreateWebSourceRequest,
  KnowledgeWebPage,
  KnowledgeWebSource,
  UpdateWebSourceRequest,
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
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import type { AppConfig } from '../../config.js';
import { EgressService } from '../../developer/egress.service.js';
import { enforce } from '../../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../../tokens.js';
import { firstRunFor } from './summary.js';
import { normalizePageUrl } from './urls.js';
import { type WebSourceRow, webPageView, webSourceView } from './views.js';

type SourceRow = typeof schema.knowledgeSources.$inferSelect;

/** Websites one workspace keeps at a time (retired ones do not count). */
const MAX_WEB_SOURCES = 20;
const MAX_PAGES_LISTED = 1000;

/** The words for an address the egress guard refuses, as the address field's error. */
function addressProblem(error: EgressError): string {
  switch (error.problem) {
    case 'insecure_url':
      return 'Use an https:// address.';
    case 'host_not_allowed':
      return 'This host is not on the list of allowed hosts. Add it under Allowed hosts first.';
    case 'private_address':
      return 'This address points to a private or local network, which Hamnivo does not read.';
    case 'unresolvable':
      return 'This website could not be found. Check the address.';
    default:
      return 'Enter the full address of the website, starting with https://.';
  }
}

/**
 * Websites as knowledge sources (G04): Studio adds a website, changes how far it reads and how
 * often, and asks for a read now. The reading itself happens in the worker (`WebSyncService`).
 * Each website is an ordinary knowledge source, so its pages are documents that can be reviewed,
 * retired and cited like any other.
 */
@Injectable()
export class WebSourcesService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly egress: EgressService,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private allowed(
    principal: StaffPrincipal,
    permission: Permission,
    resource: { workspaceId: string; brandId: string },
  ) {
    return authorize(principal, permission, resource, {
      now: this.clock(),
      stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
    });
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    webSourceId: string,
    data: Record<string, unknown>,
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'knowledge_web_source',
      targetId: toPublicId('webSource', webSourceId),
      outcome: 'success',
      data,
    });
  }

  private async load(
    tx: TenantTx,
    publicId: string,
    lock = false,
  ): Promise<{ web: WebSourceRow; source: SourceRow }> {
    let id: string;
    try {
      id = fromPublicId('webSource', publicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Website not found.' });
    }
    const query = tx
      .select({ web: schema.knowledgeWebSources, source: schema.knowledgeSources })
      .from(schema.knowledgeWebSources)
      .innerJoin(
        schema.knowledgeSources,
        eq(schema.knowledgeSources.id, schema.knowledgeWebSources.sourceId),
      )
      .where(eq(schema.knowledgeWebSources.id, id));
    const [row] = lock
      ? await query.for('update', { of: schema.knowledgeWebSources })
      : await query;
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Website not found.' });
    return row;
  }

  private async pageCounts(tx: TenantTx, ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: schema.knowledgeWebPages.webSourceId, n: count() })
      .from(schema.knowledgeWebPages)
      .where(
        and(
          inArray(schema.knowledgeWebPages.webSourceId, ids),
          isNotNull(schema.knowledgeWebPages.documentId),
          isNull(schema.knowledgeWebPages.goneAt),
        ),
      )
      .groupBy(schema.knowledgeWebPages.webSourceId);
    return new Map(rows.map((row) => [row.id, Number(row.n)]));
  }

  private async view(tx: TenantTx, web: WebSourceRow, source: SourceRow) {
    const counts = await this.pageCounts(tx, [web.id]);
    return webSourceView(web, source, counts.get(web.id) ?? 0);
  }

  async list(principal: StaffPrincipal): Promise<KnowledgeWebSource[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select({ web: schema.knowledgeWebSources, source: schema.knowledgeSources })
        .from(schema.knowledgeWebSources)
        .innerJoin(
          schema.knowledgeSources,
          eq(schema.knowledgeSources.id, schema.knowledgeWebSources.sourceId),
        )
        .orderBy(asc(schema.knowledgeWebSources.createdAt));
      const counts = await this.pageCounts(
        tx,
        rows.map((row) => row.web.id),
      );
      return rows
        .filter((row) => this.allowed(principal, 'knowledge.read', row.source).allowed)
        .map((row) => webSourceView(row.web, row.source, counts.get(row.web.id) ?? 0));
    });
  }

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateWebSourceRequest>,
  ): Promise<KnowledgeWebSource> {
    const brandId = fromPublicId('brand', input.brandId);
    const url = normalizePageUrl(input.url);
    if (!url) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'url', message: 'Enter the full address of the website.' }],
      });
    }
    return this.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      enforce(
        this.allowed(principal, 'knowledge.manage', { workspaceId: brand.workspaceId, brandId }),
      );
      try {
        await checkDestination(url, await this.egress.policyIn(tx));
      } catch (error) {
        if (!(error instanceof EgressError)) throw error;
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'url', message: addressProblem(error) }],
        });
      }
      const live = and(
        ne(schema.knowledgeSources.status, 'retired'),
        eq(schema.knowledgeSources.brandId, brandId),
      );
      const [duplicate] = await tx
        .select({ id: schema.knowledgeWebSources.id })
        .from(schema.knowledgeWebSources)
        .innerJoin(
          schema.knowledgeSources,
          eq(schema.knowledgeSources.id, schema.knowledgeWebSources.sourceId),
        )
        .where(and(live, eq(schema.knowledgeWebSources.startUrl, url)))
        .limit(1);
      if (duplicate) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'url', message: 'This website is already added for this brand.' }],
        });
      }
      const [total] = await tx
        .select({ n: count() })
        .from(schema.knowledgeWebSources)
        .innerJoin(
          schema.knowledgeSources,
          eq(schema.knowledgeSources.id, schema.knowledgeWebSources.sourceId),
        )
        .where(ne(schema.knowledgeSources.status, 'retired'));
      if (Number(total?.n ?? 0) >= MAX_WEB_SOURCES) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `A workspace can keep up to ${MAX_WEB_SOURCES} websites. Retire one first.`,
        });
      }
      const now = this.clock();
      const [source] = await tx
        .insert(schema.knowledgeSources)
        .values({
          tenantId: principal.tenantId,
          workspaceId: brand.workspaceId,
          brandId,
          name: input.name ?? new URL(url).hostname,
          visibility: input.visibility,
          ownerStaffId: principal.staffMemberId,
        })
        .returning();
      if (!source) throw new Error('source insert returned nothing');
      const [web] = await tx
        .insert(schema.knowledgeWebSources)
        .values({
          tenantId: principal.tenantId,
          sourceId: source.id,
          startUrl: url,
          mode: input.mode,
          maxPages: input.maxPages,
          maxDepth: input.maxDepth,
          schedule: input.schedule,
          // Read as soon as the worker looks: a queued read whose lease is already over.
          state: 'queued',
          leaseUntil: now,
          createdBy: principal.staffMemberId,
        })
        .returning();
      if (!web) throw new Error('web source insert returned nothing');
      await this.audit(tx, principal, 'knowledge.web_source_added', web.id, {
        url,
        mode: web.mode,
        maxPages: web.maxPages,
        maxDepth: web.maxDepth,
        schedule: web.schedule,
        visibility: source.visibility,
      });
      return webSourceView(web, source, 0);
    });
  }

  async update(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateWebSourceRequest>,
  ): Promise<KnowledgeWebSource> {
    return this.tx(principal, async (tx) => {
      const { web, source } = await this.load(tx, publicId, true);
      enforce(this.allowed(principal, 'knowledge.manage', source));
      if (source.status === 'retired') {
        throw new AppError('VALIDATION_FAILED', { detail: 'This website is retired.' });
      }
      const now = this.clock();
      const mode = input.mode ?? web.mode;
      const schedule = input.schedule ?? web.schedule;
      const changes: Partial<typeof schema.knowledgeWebSources.$inferInsert> = {
        mode,
        maxPages: input.maxPages ?? web.maxPages,
        maxDepth: input.maxDepth ?? web.maxDepth,
        schedule,
        updatedAt: now,
      };
      // A read in progress or waiting sets its own next time when it ends.
      if (schedule !== web.schedule && web.state === 'idle') {
        changes.nextRunAt = firstRunFor(schedule, web.lastRunAt, now);
      }
      const [updated] = await tx
        .update(schema.knowledgeWebSources)
        .set(changes)
        .where(eq(schema.knowledgeWebSources.id, web.id))
        .returning();
      if (!updated) throw new Error('web source update returned nothing');
      await this.audit(tx, principal, 'knowledge.web_source_updated', web.id, { ...input });
      return this.view(tx, updated, source);
    });
  }

  /** Asks for a read now: the worker picks it up within seconds. */
  async sync(principal: StaffPrincipal, publicId: string): Promise<KnowledgeWebSource> {
    return this.tx(principal, async (tx) => {
      const { web, source } = await this.load(tx, publicId, true);
      enforce(this.allowed(principal, 'knowledge.manage', source));
      if (source.status !== 'active') {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'This website is paused or retired. Turn it back on first.',
        });
      }
      const now = this.clock();
      const reading = web.state === 'running' && web.leaseUntil !== null && web.leaseUntil > now;
      if (reading) return this.view(tx, web, source);
      const [updated] = await tx
        .update(schema.knowledgeWebSources)
        .set({ state: 'queued', leaseUntil: now, updatedAt: now })
        .where(eq(schema.knowledgeWebSources.id, web.id))
        .returning();
      await this.audit(tx, principal, 'knowledge.web_sync_requested', web.id, {});
      return this.view(tx, updated ?? web, source);
    });
  }

  async pages(principal: StaffPrincipal, publicId: string): Promise<KnowledgeWebPage[]> {
    return this.tx(principal, async (tx) => {
      const { web, source } = await this.load(tx, publicId);
      enforce(this.allowed(principal, 'knowledge.read', source));
      const rows = await tx
        .select()
        .from(schema.knowledgeWebPages)
        .where(eq(schema.knowledgeWebPages.webSourceId, web.id))
        .orderBy(asc(schema.knowledgeWebPages.url))
        .limit(MAX_PAGES_LISTED);
      return rows.map(webPageView);
    });
  }
}
