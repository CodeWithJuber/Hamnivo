import { createHash } from 'node:crypto';
import {
  DEFAULT_VISITOR_SETTINGS,
  VISIT_IDLE_SECONDS,
  type VisitAck,
  type VisitorLinkRequest,
  type VisitorLinkResponse,
  type VisitorSettings,
  type VisitReport,
} from '@hamnivo/contracts';
import { type Db, resolveWidget, schema, type TenantTx, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { originAllowed } from '../widget/origins.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { isVisitorBlocked } from './blocks.js';
import { visitorNotice } from './copy.js';
import { isAutomated, readDevice } from './device.js';
import { VisitorInvites } from './invites.js';
import { cleanLanguage, cleanReferrer, cleanTitle, cleanUrl } from './privacy.js';

const V = schema.visitors;
const S = schema.visitorSessions;
const P = schema.visitorPageViews;

/** A sign of life is written at most this often, so a page left open costs little. */
const WRITE_EVERY_MS = 30_000;
/** The same page reported again within this long is one view (a page that fires twice). */
const SAME_VIEW_MS = 3000;

/** What the controller read from the request's headers (never an IP address). */
export interface VisitRequest {
  /** The `Origin` header: the website the report comes from. */
  origin: string | undefined;
  /** Do Not Track or Global Privacy Control. */
  optOut: boolean;
  userAgent: string | undefined;
  /** From `CF-IPCountry`, when Cloudflare is in front. */
  country: string | null;
}

/** A brand's visitor settings, or the defaults when it never chose. */
export async function brandVisitorSettings(
  tx: TenantTx,
  brandId: string,
): Promise<VisitorSettings> {
  const [row] = await tx
    .select()
    .from(schema.brandVisitorSettings)
    .where(eq(schema.brandVisitorSettings.brandId, brandId));
  return row
    ? { tracking: row.tracking, keepQueryStrings: row.keepQueryStrings }
    : { ...DEFAULT_VISITOR_SETTINGS };
}

/** The key the browser keeps is never stored: its SHA-256 is. */
export const hashKey = (key: string): Buffer => createHash('sha256').update(key).digest();

const OFF: VisitAck = { tracking: false, invite: null };

/**
 * Receives what the chat loader reports about a visitor's browser (which page, still here, left)
 * and links a browser to the chat that was opened in it. The brand's choice and the visitor's own
 * privacy signals decide first, and nothing is stored when either says no. An IP address is never
 * read, and page addresses lose their query string unless the brand keeps it.
 */
@Injectable()
export class VisitorTracker {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly invites: VisitorInvites,
  ) {}

  /**
   * One report from the loader. `origin` in the answer is the website to give CORS permission
   * to; a report from a website the brand did not allow is refused.
   */
  async report(
    input: VisitReport,
    request: VisitRequest,
  ): Promise<{ ack: VisitAck; origin: string }> {
    const widget = await resolveWidget(this.db, input.widgetId);
    if (widget?.brandStatus !== 'active' || widget.tenantStatus !== 'active') {
      throw new AppError('NOT_FOUND', { detail: 'This chat is not available.' });
    }
    const origin = request.origin ?? safeOrigin(input.url);
    if (!origin || !originAllowed(widget.allowedOrigins, origin)) {
      throw new AppError('ORIGIN_NOT_ALLOWED', {
        detail: 'Add this website to the brand’s allowed websites to use the chat here.',
      });
    }
    if (request.optOut || isAutomated(request.userAgent)) return { ack: OFF, origin };
    const stored = await withTenant(
      this.db,
      { tenantId: widget.tenantId, actorId: 'widget' },
      async (tx): Promise<{ tracking: boolean; visitorId: string | null }> => {
        const settings = await brandVisitorSettings(tx, widget.brandId);
        if (!settings.tracking) return { tracking: false, visitorId: null };
        const page = cleanUrl(input.url, settings.keepQueryStrings);
        // A report must be about a page of the website it came from.
        if (!page || page.origin !== origin) return { tracking: true, visitorId: null };
        const now = this.clock();
        const visitor = await this.visitorOf(tx, widget.tenantId, widget.brandId, input.key, now);
        // A blocked browser is neither followed nor invited (H20).
        if (await isVisitorBlocked(tx, widget.brandId, visitor.id, visitor.principalId, now)) {
          return { tracking: false, visitorId: null };
        }
        await this.record(tx, {
          tenantId: widget.tenantId,
          brandId: widget.brandId,
          visitor,
          event: input.event,
          page: {
            url: page.url,
            title: cleanTitle(input.title),
            referrer: cleanReferrer(input.referrer),
          },
          language: cleanLanguage(input.language),
          request,
          now,
        });
        return { tracking: true, visitorId: visitor.id };
      },
    );
    if (!stored.tracking) return { ack: OFF, origin };
    // The invitation is only looked at here; the chat takes it when the visitor opens the chat.
    const invite =
      stored.visitorId && input.event !== 'leave'
        ? await this.invites.peek(widget.tenantId, stored.visitorId)
        : null;
    return { ack: { tracking: true, invite }, origin };
  }

  /** The widget says which browser it runs in, so staff see its pages next to the chat. */
  async link(
    claims: WidgetClaims,
    input: VisitorLinkRequest,
    request: { optOut: boolean },
  ): Promise<VisitorLinkResponse> {
    const none: VisitorLinkResponse = { tracking: false, notice: null, invite: null };
    if (request.optOut) return none;
    const visitorId = await withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: 'widget' },
      async (tx) => {
        const settings = await brandVisitorSettings(tx, claims.brandId);
        if (!settings.tracking) return null;
        const now = this.clock();
        const visitor = await this.visitorOf(
          tx,
          claims.tenantId,
          claims.brandId,
          input.visitorKey,
          now,
        );
        if (visitor.principalId !== claims.principalId) {
          await tx.update(V).set({ principalId: claims.principalId }).where(eq(V.id, visitor.id));
        }
        return visitor.id;
      },
    );
    if (!visitorId) return none;
    return {
      tracking: true,
      notice: visitorNotice(input.locale),
      invite: await this.invites.take(claims.tenantId, visitorId),
    };
  }

  /** The visitor with this key, created when the browser is new. */
  private async visitorOf(
    tx: TenantTx,
    tenantId: string,
    brandId: string,
    key: string,
    now: Date,
  ): Promise<typeof V.$inferSelect> {
    const keyHash = hashKey(key);
    const find = async () => {
      const [row] = await tx
        .select()
        .from(V)
        .where(and(eq(V.brandId, brandId), eq(V.keyHash, keyHash)));
      return row;
    };
    const existing = await find();
    if (existing) return existing;
    await tx
      .insert(V)
      .values({ tenantId, brandId, keyHash, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoNothing();
    // Another report for the same new browser may have won the insert.
    const created = await find();
    if (!created) throw new AppError('INTERNAL', { internal: 'visitor row missing after insert' });
    return created;
  }

  /** Stores one report: starts a visit when there is none, adds a page view, or ends the visit. */
  private async record(
    tx: TenantTx,
    input: {
      tenantId: string;
      brandId: string;
      visitor: typeof V.$inferSelect;
      event: VisitReport['event'];
      page: { url: string; title: string | null; referrer: string | null };
      language: string | null;
      request: VisitRequest;
      now: Date;
    },
  ): Promise<void> {
    const { tenantId, brandId, visitor, page, now } = input;
    const idleMs = VISIT_IDLE_SECONDS * 1000;
    const [open] = await tx
      .select()
      .from(S)
      .where(and(eq(S.visitorId, visitor.id), isNull(S.endedAt)))
      .orderBy(desc(S.lastSeenAt))
      .limit(1);
    const current = open && now.getTime() - open.lastSeenAt.getTime() < idleMs ? open : undefined;

    if (input.event === 'leave') {
      if (current) {
        await tx.update(S).set({ endedAt: now, lastSeenAt: now }).where(eq(S.id, current.id));
      }
      return;
    }
    // A visit that went quiet without a "leave" (a closed laptop) ended when it was last seen.
    if (open && !current) {
      await tx.update(S).set({ endedAt: open.lastSeenAt }).where(eq(S.id, open.id));
    }

    let session = current;
    let counted = false;
    if (!session) {
      const [earlier] = await tx
        .select({ id: S.id })
        .from(S)
        .where(eq(S.visitorId, visitor.id))
        .limit(1);
      const device = readDevice(input.request.userAgent);
      const [created] = await tx
        .insert(S)
        .values({
          tenantId,
          brandId,
          visitorId: visitor.id,
          startedAt: now,
          lastSeenAt: now,
          country: input.request.country,
          browser: device.browser,
          browserVersion: device.browserVersion,
          os: device.os,
          osVersion: device.osVersion,
          deviceType: device.deviceType,
          language: input.language,
          referrer: page.referrer,
          entryUrl: page.url,
          currentUrl: page.url,
          currentTitle: page.title,
          pageCount: 0,
        })
        .returning();
      if (!created) throw new AppError('INTERNAL', { internal: 'visit row missing after insert' });
      session = created;
      // The first visit is the one the visitor row started with; each one after adds to the count.
      if (earlier) {
        await tx
          .update(V)
          .set({ visitCount: sql`${V.visitCount} + 1` })
          .where(eq(V.id, visitor.id));
        counted = true;
      }
    }

    // A beat for the page already shown only says "still here"; a new page is a view.
    const view =
      input.event === 'view' || page.url !== session.currentUrl || session.pageCount === 0;
    if (view) {
      const [last] = await tx
        .select({ url: P.url, viewedAt: P.viewedAt })
        .from(P)
        .where(eq(P.sessionId, session.id))
        .orderBy(desc(P.viewedAt))
        .limit(1);
      const repeat =
        last?.url === page.url && now.getTime() - last.viewedAt.getTime() < SAME_VIEW_MS;
      if (!repeat) {
        await tx.insert(P).values({
          tenantId,
          brandId,
          visitorId: visitor.id,
          sessionId: session.id,
          url: page.url,
          title: page.title,
          referrer: page.referrer,
          viewedAt: now,
        });
      }
      await tx
        .update(S)
        .set({
          currentUrl: page.url,
          currentTitle: page.title,
          pageCount: repeat ? session.pageCount : session.pageCount + 1,
          lastSeenAt: now,
        })
        .where(eq(S.id, session.id));
    } else if (now.getTime() - session.lastSeenAt.getTime() >= WRITE_EVERY_MS) {
      await tx.update(S).set({ lastSeenAt: now }).where(eq(S.id, session.id));
    }
    if (view || counted || now.getTime() - visitor.lastSeenAt.getTime() >= WRITE_EVERY_MS) {
      await tx.update(V).set({ lastSeenAt: now }).where(eq(V.id, visitor.id));
    }
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
