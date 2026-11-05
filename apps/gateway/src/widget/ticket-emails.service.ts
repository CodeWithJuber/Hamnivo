import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ticketReference } from '@hamnivo/contracts';
import { type ClaimedOutboxEvent, type Db, schema, type TenantTx, withTenant } from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import { sendBrandedCustomerMail } from '../branding/customer-email.js';
import type { AppConfig } from '../config.js';
import type { Mailer } from '../platform/mailer.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER } from '../tokens.js';
import { escapeHtml } from './notifications.service.js';
import { notifyLocale } from './notifications-copy.js';
import { originAllowed } from './origins.js';
import { brandSurface, directLinkUrl } from './settings.service.js';
import { TICKET_COPY } from './ticket-copy.js';
import { sha256 } from './tokens.service.js';

/** What a confirmation link names: the tenant, the ticket's follow-up and a one-time nonce. */
interface ConfirmClaims {
  t: string;
  f: string;
  n: string;
}

/**
 * Signs and checks the links that confirm a ticket's address (W11, H19), with a key derived from
 * the key-encryption key. The link is also single-use in effect: only the latest one sent for a
 * ticket matches the hash kept with it.
 */
export class TicketEmailTokens {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    this.key = createHmac('sha256', config.kek.key).update('hamnivo:ticket-email:v1').digest();
  }

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.key).update(payload).digest();
  }

  sign(claims: ConfirmClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${this.mac(payload).toString('base64url')}`;
  }

  verify(token: string): ConfirmClaims | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = this.mac(payload);
    const given = Buffer.from(signature, 'base64url');
    // Only the canonical spelling of the signature counts (see UnsubscribeTokens).
    if (given.toString('base64url') !== signature) return null;
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (
        typeof claims?.t === 'string' &&
        typeof claims?.f === 'string' &&
        typeof claims?.n === 'string'
      ) {
        return claims as ConfirmClaims;
      }
    } catch {
      // falls through
    }
    return null;
  }
}

/** Where the customer can open the chat again: the direct link, or the website they used. */
export async function chatLink(
  tx: TenantTx,
  config: AppConfig,
  brand: typeof schema.brands.$inferSelect,
  principalId: string,
): Promise<string | null> {
  const surface = await brandSurface(tx, brand.id);
  if (surface.directLink) return directLinkUrl(config.PUBLIC_WIDGET_ORIGIN, brand.widgetPublicId);
  const [session] = await tx
    .select({ hostOrigin: schema.widgetSessions.hostOrigin })
    .from(schema.widgetSessions)
    .where(
      and(
        eq(schema.widgetSessions.principalId, principalId),
        ne(schema.widgetSessions.hostOrigin, 'unknown'),
      ),
    )
    .orderBy(desc(schema.widgetSessions.lastUsedAt))
    .limit(1);
  return session && originAllowed(brand.allowedOrigins, session.hostOrigin)
    ? session.hostOrigin
    : null;
}

function page(lang: string, title: string, body: string): string {
  const dir = lang === 'ar' || lang === 'ur' ? 'rtl' : 'ltr';
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body><main>${body}</main></body>
</html>`;
}

/**
 * The emails of a ticket from the contact form (W11, H19): the one confirmation, sent by the
 * worker, and the page its link opens, which asks before confirming (link scanners open links).
 * Answers by email follow once the address is confirmed (CustomerEmailsService).
 */
@Injectable()
export class TicketEmailsService {
  private readonly logger = new Logger(TicketEmailsService.name);
  private readonly tokens: TicketEmailTokens;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {
    this.tokens = new TicketEmailTokens(config);
  }

  private confirmUrl(token: string): string {
    return `${this.config.PUBLIC_API_ORIGIN.replace(/\/$/, '')}/v1/notifications/confirm-email?token=${token}`;
  }

  /** Outbox handler for `customer.ticket_confirm`: the confirmation email. Sent once. */
  async onConfirm(event: ClaimedOutboxEvent): Promise<void> {
    const { followupId } = event.payload as { followupId: string };
    const tenantId = event.tenantId;
    const found = await withTenant(this.db, { tenantId, actorId: 'notifications' }, async (tx) => {
      const [followup] = await tx
        .select()
        .from(schema.ticketFollowups)
        .where(eq(schema.ticketFollowups.id, followupId));
      if (!followup || followup.confirmationSentAt || followup.confirmedAt) return null;
      const [brand] = await tx
        .select()
        .from(schema.brands)
        .where(eq(schema.brands.id, followup.brandId));
      const [state] = await tx
        .select({ number: schema.conversationInboxState.ticketNumber })
        .from(schema.conversationInboxState)
        .where(eq(schema.conversationInboxState.conversationId, followup.conversationId));
      const [principal] = await tx
        .select({ locale: schema.customerPrincipals.locale })
        .from(schema.customerPrincipals)
        .where(eq(schema.customerPrincipals.id, followup.principalId));
      if (!brand || !state?.number) return null;
      return { followup, brand, number: state.number, locale: principal?.locale ?? null };
    });
    if (!found) return;
    const token = this.tokens.sign({
      t: tenantId,
      f: followupId,
      n: randomBytes(12).toString('base64url'),
    });
    const copy = TICKET_COPY[notifyLocale(found.locale)];
    const reference = ticketReference(found.number);
    await sendBrandedCustomerMail(this.db, this.mailer, tenantId, found.brand.name, {
      to: found.followup.email,
      subject: copy.confirmSubject(found.brand.name, reference),
      text: [
        copy.confirmBody(found.brand.name, reference),
        '',
        `${copy.confirmAction} ${this.confirmUrl(token)}`,
        '',
        '—',
        copy.notYou(found.brand.name),
      ].join('\n'),
      senderName: found.brand.name,
      template: 'customer.ticket_confirm',
    });
    await withTenant(this.db, { tenantId, actorId: 'notifications' }, (tx) =>
      tx
        .update(schema.ticketFollowups)
        .set({ confirmTokenHash: sha256(token), confirmationSentAt: this.clock() })
        .where(eq(schema.ticketFollowups.id, followupId)),
    );
    this.logger.log(`ticket confirmation sent for conversation ${found.followup.conversationId}`);
  }

  private async subject(token: string) {
    const claims = this.tokens.verify(token);
    if (!claims) return null;
    try {
      return await withTenant(this.db, { tenantId: claims.t }, async (tx) => {
        const [followup] = await tx
          .select()
          .from(schema.ticketFollowups)
          .where(eq(schema.ticketFollowups.id, claims.f));
        if (!followup) return null;
        const given = sha256(token);
        if (
          followup.confirmTokenHash.length !== given.length ||
          !timingSafeEqual(followup.confirmTokenHash, given)
        ) {
          return null;
        }
        const [brand] = await tx
          .select({ name: schema.brands.name })
          .from(schema.brands)
          .where(eq(schema.brands.id, followup.brandId));
        const [state] = await tx
          .select({ number: schema.conversationInboxState.ticketNumber })
          .from(schema.conversationInboxState)
          .where(eq(schema.conversationInboxState.conversationId, followup.conversationId));
        const [principal] = await tx
          .select({ locale: schema.customerPrincipals.locale })
          .from(schema.customerPrincipals)
          .where(eq(schema.customerPrincipals.id, followup.principalId));
        return {
          claims,
          followup,
          brand: brand?.name ?? '',
          reference: ticketReference(state?.number ?? 0),
          lang: notifyLocale(principal?.locale),
        };
      });
    } catch {
      return null;
    }
  }

  private invalid(): { status: number; html: string } {
    const copy = TICKET_COPY.en;
    return {
      status: 404,
      html: page(
        'en',
        copy.pageTitle,
        `<h1>${escapeHtml(copy.pageTitle)}</h1><p>${escapeHtml(copy.invalid)}</p>`,
      ),
    };
  }

  /** The page the confirmation link opens: it asks first, so nothing changes on a mere visit. */
  async confirmPage(token: string): Promise<{ status: number; html: string }> {
    const found = await this.subject(token);
    if (!found) return this.invalid();
    const copy = TICKET_COPY[found.lang];
    if (found.followup.confirmedAt) {
      return {
        status: 200,
        html: page(
          found.lang,
          copy.pageTitle,
          `<h1>${escapeHtml(copy.pageTitle)}</h1><p>${escapeHtml(copy.confirmed(found.brand))}</p>`,
        ),
      };
    }
    const action = `/v1/notifications/confirm-email?token=${encodeURIComponent(token)}`;
    return {
      status: 200,
      html: page(
        found.lang,
        copy.pageTitle,
        `<h1>${escapeHtml(copy.pageTitle)}</h1><p>${escapeHtml(copy.pageQuestion(found.brand, found.reference))}</p><form method="post" action="${escapeHtml(action)}"><button type="submit">${escapeHtml(copy.pageButton)}</button></form>`,
      ),
    };
  }

  /** Confirms the address. Idempotent: a second press changes nothing. */
  async confirm(token: string): Promise<{ status: number; html: string }> {
    const found = await this.subject(token);
    if (!found) return this.invalid();
    if (!found.followup.confirmedAt) {
      await withTenant(this.db, { tenantId: found.claims.t, actorId: 'notifications' }, (tx) =>
        tx
          .update(schema.ticketFollowups)
          .set({ confirmedAt: this.clock() })
          .where(
            and(
              eq(schema.ticketFollowups.id, found.followup.id),
              isNotNull(schema.ticketFollowups.confirmationSentAt),
            ),
          ),
      );
    }
    const copy = TICKET_COPY[found.lang];
    return {
      status: 200,
      html: page(
        found.lang,
        copy.pageTitle,
        `<h1>${escapeHtml(copy.pageTitle)}</h1><p>${escapeHtml(copy.confirmed(found.brand))}</p>`,
      ),
    };
  }
}
