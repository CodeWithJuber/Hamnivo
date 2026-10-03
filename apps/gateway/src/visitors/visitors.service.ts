import {
  type ConversationVisitor,
  type LiveVisitor,
  type LiveVisitorList,
  VISITOR_ONLINE_SECONDS,
  type VisitorCard,
  type VisitorInviteResult,
  type VisitorSettings,
  type VisitorSettingsView,
} from '@hamnivo/contracts';
import { appendAudit, fromPublicId, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess, type VisibleScope } from '../inbox/access.js';
import { CLOCK, type Clock } from '../tokens.js';
import { VisitorInvites } from './invites.js';
import { brandVisitorSettings } from './tracker.service.js';

const V = schema.visitors;
const S = schema.visitorSessions;
const P = schema.visitorPageViews;
const C = schema.conversationControls;

/** The most visitors the live page lists. */
const LIVE_LIMIT = 200;

/** "Chrome 120", "Windows 10": the name, and the main version when there is one. */
const named = (name: string | null, version: string | null): string | null =>
  name ? (version ? `${name} ${version}` : name) : null;

/** Visitors belong to a brand, so only grants that reach the brand (or more) show them. */
function brandCondition(scope: VisibleScope): SQL | undefined {
  if (scope.all) return undefined;
  const parts: SQL[] = [];
  if (scope.brandIds.length) parts.push(inArray(S.brandId, scope.brandIds));
  if (scope.workspaceIds.length) parts.push(inArray(schema.brands.workspaceId, scope.workspaceIds));
  return parts.length ? or(...parts) : sql`false`;
}

/**
 * Visitors for staff: who is on a brand's website now, the card next to a conversation, invitations
 * to chat and each brand's tracking settings. What a person sees follows their grants: only
 * visitors of brands their role reaches, and inviting needs the right to reply.
 */
@Injectable()
export class VisitorsService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: InboxAccess,
    private readonly invites: VisitorInvites,
  ) {}

  async live(principal: StaffPrincipal, query: { brandId?: string }): Promise<LiveVisitorList> {
    const scope = this.access.scope(principal);
    if (!scope) {
      throw new AppError('SCOPE_DENIED', {
        detail: 'Your role does not include reading conversations.',
      });
    }
    let brandFilter: string | undefined;
    if (query.brandId) {
      try {
        brandFilter = fromPublicId('brand', query.brandId);
      } catch {
        throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      }
    }
    const now = this.clock();
    const since = new Date(now.getTime() - VISITOR_ONLINE_SECONDS * 1000);
    return this.access.tx(principal, async (tx) => {
      const rows = await tx
        .select({
          visitorId: V.id,
          principalId: V.principalId,
          visitCount: V.visitCount,
          brandId: S.brandId,
          brandName: schema.brands.name,
          workspaceId: schema.brands.workspaceId,
          name: schema.customerPrincipals.displayName,
          kind: schema.customerPrincipals.kind,
          startedAt: S.startedAt,
          lastSeenAt: S.lastSeenAt,
          country: S.country,
          browser: S.browser,
          browserVersion: S.browserVersion,
          os: S.os,
          osVersion: S.osVersion,
          deviceType: S.deviceType,
          url: S.currentUrl,
          title: S.currentTitle,
          referrer: S.referrer,
        })
        .from(S)
        .innerJoin(V, eq(V.id, S.visitorId))
        .innerJoin(schema.brands, eq(schema.brands.id, S.brandId))
        .leftJoin(schema.customerPrincipals, eq(schema.customerPrincipals.id, V.principalId))
        .where(
          and(
            isNull(S.endedAt),
            gt(S.lastSeenAt, since),
            brandCondition(scope),
            brandFilter ? eq(S.brandId, brandFilter) : undefined,
          ),
        )
        .orderBy(desc(S.lastSeenAt))
        .limit(LIVE_LIMIT * 2);
      // A visitor with the website open in two tabs has two visits: show the one seen last.
      const byVisitor = new Map<string, (typeof rows)[number]>();
      for (const row of rows) if (!byVisitor.has(row.visitorId)) byVisitor.set(row.visitorId, row);
      const shown = [...byVisitor.values()]
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, LIVE_LIMIT);

      const principalIds = [
        ...new Set(shown.flatMap((row) => (row.principalId ? [row.principalId] : []))),
      ];
      const open = principalIds.length
        ? await tx
            .select({ id: C.id, principalId: C.principalId, brandId: C.brandId })
            .from(C)
            .where(
              and(
                inArray(C.principalId, principalIds),
                inArray(C.authorityStatus, ['open', 'pending']),
              ),
            )
            .orderBy(desc(C.lastActivityAt))
        : [];
      const conversationOf = (principalId: string | null, brandId: string) =>
        principalId
          ? open.find((c) => c.principalId === principalId && c.brandId === brandId)?.id
          : undefined;

      const items = shown.map((row): LiveVisitor => {
        const id = toPublicId('visitor', row.visitorId);
        const given = row.name?.trim();
        const conversationId = conversationOf(row.principalId, row.brandId);
        return {
          id: id as LiveVisitor['id'],
          brand: {
            id: toPublicId('brand', row.brandId) as LiveVisitor['brand']['id'],
            name: row.brandName,
          },
          name: given || `Visitor ${id.slice(-4).toUpperCase()}`,
          identified: Boolean(given) || row.kind === 'verified',
          page: { url: row.url, title: row.title },
          startedAt: row.startedAt.toISOString() as LiveVisitor['startedAt'],
          lastSeenAt: row.lastSeenAt.toISOString() as LiveVisitor['lastSeenAt'],
          country: row.country,
          device: {
            type: row.deviceType,
            browser: named(row.browser, row.browserVersion),
            os: named(row.os, row.osVersion),
          },
          returning: row.visitCount > 1,
          visitCount: row.visitCount,
          referrer: row.referrer,
          conversationId: (conversationId
            ? toPublicId('conversation', conversationId)
            : null) as LiveVisitor['conversationId'],
          canInvite: this.access.can(principal, 'conversations.reply', {
            workspaceId: row.workspaceId,
            brandId: row.brandId,
          }),
        };
      });
      return { items, generatedAt: now.toISOString() as LiveVisitorList['generatedAt'] };
    });
  }

  /** The pages, device and visit count of the browser a customer chatted from. */
  async conversationVisitor(
    principal: StaffPrincipal,
    conversationPublicId: string,
  ): Promise<ConversationVisitor> {
    const now = this.clock();
    return this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(
        tx,
        principal,
        conversationPublicId,
        'conversations.read',
      );
      const { principalId, brandId } = found.control;
      if (!brandId) return { tracking: false, visitor: null };
      const settings = await brandVisitorSettings(tx, brandId);
      // A conversation that did not start in the chat widget has no browser to show.
      if (!principalId) return { tracking: settings.tracking, visitor: null };
      const [visitor] = await tx
        .select()
        .from(V)
        .where(and(eq(V.principalId, principalId), eq(V.brandId, brandId)))
        .orderBy(desc(V.lastSeenAt))
        .limit(1);
      if (!visitor) return { tracking: settings.tracking, visitor: null };
      const [session] = await tx
        .select()
        .from(S)
        .where(eq(S.visitorId, visitor.id))
        .orderBy(desc(S.startedAt))
        .limit(1);
      if (!session) return { tracking: settings.tracking, visitor: null };
      const pages = await tx
        .select({ url: P.url, title: P.title, viewedAt: P.viewedAt })
        .from(P)
        .where(eq(P.sessionId, session.id))
        .orderBy(desc(P.viewedAt))
        .limit(20);
      const online =
        session.endedAt === null &&
        now.getTime() - session.lastSeenAt.getTime() < VISITOR_ONLINE_SECONDS * 1000;
      const until = online ? now : session.lastSeenAt;
      const card: VisitorCard = {
        id: toPublicId('visitor', visitor.id) as VisitorCard['id'],
        firstSeenAt: visitor.firstSeenAt.toISOString() as VisitorCard['firstSeenAt'],
        lastSeenAt: visitor.lastSeenAt.toISOString() as VisitorCard['lastSeenAt'],
        visitCount: visitor.visitCount,
        returning: visitor.visitCount > 1,
        online,
        country: session.country,
        device: {
          type: session.deviceType,
          browser: named(session.browser, session.browserVersion),
          os: named(session.os, session.osVersion),
        },
        language: session.language,
        referrer: session.referrer,
        entryUrl: session.entryUrl,
        currentPage: { url: session.currentUrl, title: session.currentTitle },
        visitStartedAt: session.startedAt.toISOString() as VisitorCard['visitStartedAt'],
        timeOnSiteSeconds: Math.max(
          0,
          Math.round((until.getTime() - session.startedAt.getTime()) / 1000),
        ),
        pages: pages.map((page) => ({
          url: page.url,
          title: page.title,
          viewedAt: page.viewedAt.toISOString() as VisitorCard['pages'][number]['viewedAt'],
        })),
      };
      return { tracking: settings.tracking, visitor: card };
    });
  }

  /** Shows a visitor a message next to the chat button (it goes out with their next report). */
  async invite(
    principal: StaffPrincipal,
    visitorPublicId: string,
    message: string,
  ): Promise<VisitorInviteResult> {
    const now = this.clock();
    const target = await this.access.tx(principal, async (tx) => {
      let visitorId: string;
      try {
        visitorId = fromPublicId('visitor', visitorPublicId);
      } catch {
        throw new AppError('NOT_FOUND', { detail: 'Visitor not found.' });
      }
      const [row] = await tx
        .select({
          id: V.id,
          brandId: V.brandId,
          workspaceId: schema.brands.workspaceId,
        })
        .from(V)
        .innerJoin(schema.brands, eq(schema.brands.id, V.brandId))
        .where(eq(V.id, visitorId));
      const scope = this.access.scope(principal);
      const seen =
        row && scope
          ? scope.all ||
            scope.brandIds.includes(row.brandId) ||
            scope.workspaceIds.includes(row.workspaceId)
          : false;
      if (!row || !seen) throw new AppError('NOT_FOUND', { detail: 'Visitor not found.' });
      enforce(
        this.access.decide(principal, 'conversations.reply', {
          workspaceId: row.workspaceId,
          brandId: row.brandId,
        }),
      );
      const settings = await brandVisitorSettings(tx, row.brandId);
      const [session] = await tx
        .select({ lastSeenAt: S.lastSeenAt, endedAt: S.endedAt })
        .from(S)
        .where(eq(S.visitorId, row.id))
        .orderBy(desc(S.lastSeenAt))
        .limit(1);
      const here =
        settings.tracking &&
        session !== undefined &&
        session.endedAt === null &&
        now.getTime() - session.lastSeenAt.getTime() < VISITOR_ONLINE_SECONDS * 1000;
      if (!here) throw new AppError('NOT_FOUND', { detail: 'This visitor has left the website.' });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'visitor.invited',
        targetType: 'visitor',
        targetId: visitorPublicId,
        outcome: 'success',
        data: { brandId: toPublicId('brand', row.brandId), message },
      });
      return row;
    });
    const { expiresAt } = await this.invites.offer(principal.tenantId, target.id, message);
    return { expiresAt: expiresAt.toISOString() as VisitorInviteResult['expiresAt'] };
  }

  // ---------------------------------------------------------------- brand settings

  /** The brand, locked when it changes, once the caller may act on it. */
  private async brand(
    tx: TenantTx,
    principal: StaffPrincipal,
    brandPublicId: string,
    permission: Permission,
    lock: boolean,
  ) {
    let brandId: string;
    try {
      brandId = fromPublicId('brand', brandPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    }
    const query = tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    const [brand] = lock ? await query.for('update') : await query;
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    enforce(this.access.decide(principal, permission, { workspaceId: brand.workspaceId, brandId }));
    return brand;
  }

  async getSettings(principal: StaffPrincipal, brandId: string): Promise<VisitorSettingsView> {
    return this.access.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', false);
      const [row] = await tx
        .select({ updatedAt: schema.brandVisitorSettings.updatedAt })
        .from(schema.brandVisitorSettings)
        .where(eq(schema.brandVisitorSettings.brandId, brand.id));
      return {
        brandId: brandId as VisitorSettingsView['brandId'],
        settings: await brandVisitorSettings(tx, brand.id),
        updatedAt: (row?.updatedAt.toISOString() ?? null) as VisitorSettingsView['updatedAt'],
      };
    });
  }

  async updateSettings(
    principal: StaffPrincipal,
    brandId: string,
    settings: VisitorSettings,
  ): Promise<VisitorSettingsView> {
    const now = this.clock();
    return this.access.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', true);
      const before = await brandVisitorSettings(tx, brand.id);
      await tx
        .insert(schema.brandVisitorSettings)
        .values({
          tenantId: brand.tenantId,
          brandId: brand.id,
          tracking: settings.tracking,
          keepQueryStrings: settings.keepQueryStrings,
          updatedBy: principal.staffMemberId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.brandVisitorSettings.tenantId, schema.brandVisitorSettings.brandId],
          set: {
            tracking: settings.tracking,
            keepQueryStrings: settings.keepQueryStrings,
            updatedBy: principal.staffMemberId,
            updatedAt: now,
          },
        });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'brand.visitor_settings.updated',
        targetType: 'brand',
        targetId: brandId,
        outcome: 'success',
        data: { before, after: settings },
      });
      return {
        brandId: brandId as VisitorSettingsView['brandId'],
        settings,
        updatedAt: now.toISOString() as VisitorSettingsView['updatedAt'],
      };
    });
  }
}
