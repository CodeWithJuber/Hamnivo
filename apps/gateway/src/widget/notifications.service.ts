import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  NotificationPreferences,
  UpdateNotificationPreferencesRequest,
} from '@hamnivo/contracts';
import { type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { NOTIFY_COPY, notifyLocale } from './notifications-copy.js';
import { brandSurface } from './settings.service.js';
import type { WidgetClaims } from './tokens.service.js';

export type EmailKind = 'transcript' | 'reply_waiting' | 'all';

interface UnsubscribeClaims {
  /** Tenant, principal and which emails. */
  t: string;
  p: string;
  k: EmailKind;
}

/** f•••@example.com: enough to recognise one's own address, not enough to read it out. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Signs and checks unsubscribe links (W25) with a key derived from the key-encryption key. */
export class UnsubscribeTokens {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    this.key = createHmac('sha256', config.kek.key).update('hamnivo:unsubscribe:v1').digest();
  }

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.key).update(payload).digest();
  }

  sign(claims: UnsubscribeClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${this.mac(payload).toString('base64url')}`;
  }

  verify(token: string): UnsubscribeClaims | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = this.mac(payload);
    const given = Buffer.from(signature, 'base64url');
    // Only the one spelling of the signature counts: the last of its 43 characters has spare bits
    // that decoding ignores, so a link with another last character would still verify.
    if (given.toString('base64url') !== signature) return null;
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (
        typeof claims?.t === 'string' &&
        typeof claims?.p === 'string' &&
        ['transcript', 'reply_waiting', 'all'].includes(claims?.k)
      ) {
        return claims as UnsubscribeClaims;
      }
    } catch {
      // falls through
    }
    return null;
  }
}

type PrincipalRow = typeof schema.customerPrincipals.$inferSelect;

/**
 * Email notifications for customers (W25). Only a verified customer with a verified address (from
 * the website's signed assertion) can turn them on, and only where the brand offers them. Every
 * email carries a signed link that turns it off without signing in; the link asks first.
 */
@Injectable()
export class WidgetNotificationsService {
  private readonly tokens: UnsubscribeTokens;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.tokens = new UnsubscribeTokens(config);
  }

  private tx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      work,
    );
  }

  private async view(tx: TenantTx, claims: WidgetClaims): Promise<NotificationPreferences> {
    const [principal] = await tx
      .select()
      .from(schema.customerPrincipals)
      .where(eq(schema.customerPrincipals.id, claims.principalId));
    const { settings } = await brandSurface(tx, claims.brandId);
    const [prefs] = await tx
      .select()
      .from(schema.customerNotificationPreferences)
      .where(eq(schema.customerNotificationPreferences.principalId, claims.principalId));
    const reason = !settings.notifications.email
      ? ('turned_off_by_brand' as const)
      : principal?.kind !== 'verified'
        ? ('not_verified' as const)
        : !principal.email || !principal.emailVerifiedAt
          ? ('no_verified_email' as const)
          : null;
    const available = reason === null;
    return {
      available,
      reason,
      email: available && principal?.email ? maskEmail(principal.email) : null,
      transcript: available && prefs?.transcript === true,
      replyWaiting: available && prefs?.replyWaiting === true,
    };
  }

  get(claims: WidgetClaims): Promise<NotificationPreferences> {
    return this.tx(claims, (tx) => this.view(tx, claims));
  }

  update(
    claims: WidgetClaims,
    input: z.output<typeof UpdateNotificationPreferencesRequest>,
  ): Promise<NotificationPreferences> {
    return this.tx(claims, async (tx) => {
      const current = await this.view(tx, claims);
      if (!current.available) {
        throw current.reason === 'turned_off_by_brand'
          ? new AppError('FEATURE_DISABLED', { detail: 'This chat doesn’t send emails.' })
          : new AppError('IDENTITY_REQUIRED', {
              detail: 'Sign in on the website with a verified email address to get emails.',
            });
      }
      const now = this.clock();
      const values = {
        ...(input.transcript !== undefined ? { transcript: input.transcript } : {}),
        ...(input.replyWaiting !== undefined ? { replyWaiting: input.replyWaiting } : {}),
      };
      await tx
        .insert(schema.customerNotificationPreferences)
        .values({
          tenantId: claims.tenantId,
          brandId: claims.brandId,
          principalId: claims.principalId,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            schema.customerNotificationPreferences.tenantId,
            schema.customerNotificationPreferences.principalId,
          ],
          set: { ...values, updatedAt: now },
        });
      return this.view(tx, claims);
    });
  }

  /** A link for one kind of email, for one customer. */
  unsubscribeUrl(apiOrigin: string, tenantId: string, principalId: string, kind: EmailKind) {
    const token = this.tokens.sign({ t: tenantId, p: principalId, k: kind });
    return `${apiOrigin.replace(/\/$/, '')}/v1/notifications/unsubscribe?token=${token}`;
  }

  private page(locale: string, title: string, body: string): string {
    const lang = notifyLocale(locale);
    const dir = lang === 'ar' || lang === 'ur' ? 'rtl' : 'ltr';
    return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title></head>
<body><main>${body}</main></body>
</html>`;
  }

  private async subject(
    token: string,
  ): Promise<{ claims: UnsubscribeClaims; principal: PrincipalRow; brand: string } | null> {
    const claims = this.tokens.verify(token);
    if (!claims) return null;
    try {
      return await withTenant(this.db, { tenantId: claims.t }, async (tx) => {
        const [principal] = await tx
          .select()
          .from(schema.customerPrincipals)
          .where(eq(schema.customerPrincipals.id, claims.p));
        if (!principal) return null;
        const [brand] = await tx
          .select({ name: schema.brands.name })
          .from(schema.brands)
          .where(eq(schema.brands.id, principal.brandId));
        return { claims, principal, brand: brand?.name ?? '' };
      });
    } catch {
      return null;
    }
  }

  /** The page an unsubscribe link opens: it asks before changing anything (link scanners). */
  async confirmPage(token: string): Promise<{ status: number; html: string }> {
    const found = await this.subject(token);
    if (!found) {
      const copy = NOTIFY_COPY.en;
      return {
        status: 404,
        html: this.page(
          'en',
          copy.pageTitle,
          `<h1>${escapeHtml(copy.pageTitle)}</h1><p>${escapeHtml(copy.invalid)}</p>`,
        ),
      };
    }
    const lang = notifyLocale(found.principal.locale);
    const copy = NOTIFY_COPY[lang];
    const action = `/v1/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
    return {
      status: 200,
      html: this.page(
        lang,
        copy.pageTitle,
        `<h1>${escapeHtml(copy.pageTitle)}</h1><p><bdi>${escapeHtml(found.brand)}</bdi></p><p>${escapeHtml(copy.confirmQuestion[found.claims.k])}</p><form method="post" action="${escapeHtml(action)}"><button type="submit">${escapeHtml(copy.confirmButton)}</button></form>`,
      ),
    };
  }

  /** Turns the emails off (also RFC 8058 one-click from a mail client). Idempotent. */
  async unsubscribe(token: string): Promise<{ status: number; html: string }> {
    const found = await this.subject(token);
    if (!found) return this.confirmPage(token);
    const { claims } = found;
    const now = this.clock();
    await withTenant(this.db, { tenantId: claims.t }, async (tx) => {
      const off = {
        ...(claims.k === 'transcript' || claims.k === 'all' ? { transcript: false } : {}),
        ...(claims.k === 'reply_waiting' || claims.k === 'all' ? { replyWaiting: false } : {}),
      };
      await tx
        .insert(schema.customerNotificationPreferences)
        .values({
          tenantId: claims.t,
          brandId: found.principal.brandId,
          principalId: claims.p,
          unsubscribedAt: now,
          ...off,
        })
        .onConflictDoUpdate({
          target: [
            schema.customerNotificationPreferences.tenantId,
            schema.customerNotificationPreferences.principalId,
          ],
          set: { ...off, unsubscribedAt: now, updatedAt: now },
        });
    });
    const lang = notifyLocale(found.principal.locale);
    const copy = NOTIFY_COPY[lang];
    return {
      status: 200,
      html: this.page(
        lang,
        copy.pageTitle,
        `<h1>${escapeHtml(copy.pageTitle)}</h1><p role="status">${escapeHtml(copy.done[claims.k])}</p><p>${escapeHtml(copy.changeLater)}</p>`,
      ),
    };
  }
}
