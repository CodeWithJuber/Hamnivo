import { type ClaimedOutboxEvent, type Db, schema, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { type Mailer, sendTemplate } from '../platform/mailer.js';
import { senderNameOf } from '../platform/workspace-email.js';
import { APP_DB, CONFIG, MAILER } from '../tokens.js';

/** Outbox topic of billing emails, queued with the change that causes them. */
export const BILLING_NOTICE_TOPIC = 'billing.notice';

export type BillingNotice =
  | {
      kind: 'receipt';
      invoiceId: string;
      number: string | null;
      amountMinor: string;
      currency: string;
      paidAt: string;
      url: string | null;
    }
  | {
      kind: 'payment_failed';
      invoiceId: string;
      number: string | null;
      amountMinor: string;
      currency: string;
      graceEndsAt: string | null;
      url: string | null;
    };

/** An amount in minor units, written for people (`USD 49.00` → "$49.00"). */
export function formatMinor(amountMinor: string, currency: string): string {
  const format = new Intl.NumberFormat('en', { style: 'currency', currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  const minor = BigInt(amountMinor);
  const unit = 10n ** BigInt(digits);
  const whole = minor / unit;
  const fraction = (minor < 0n ? -minor : minor) % unit;
  return format.format(Number(`${whole}.${fraction.toString().padStart(digits, '0')}`));
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));

/**
 * Sends billing emails to the workspace's owners: a receipt when an invoice is paid and a notice
 * when a payment failed, with the date the plan falls back to free. Each outbox event is sent
 * once (processed_events), inside the workspace's transaction, so a failure is retried.
 */
@Injectable()
export class BillingNotices {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async onNotice(event: ClaimedOutboxEvent): Promise<void> {
    const notice = event.payload as unknown as BillingNotice;
    await withTenant(this.db, { tenantId: event.tenantId, actorId: 'billing' }, async (tx) => {
      const [claimed] = await tx
        .insert(schema.processedEvents)
        .values({ tenantId: event.tenantId, consumer: BILLING_NOTICE_TOPIC, eventId: event.id })
        .onConflictDoNothing()
        .returning({ eventId: schema.processedEvents.eventId });
      if (!claimed) return;
      const s = schema.staffMembers;
      const owners = await tx
        .selectDistinct({ email: s.email })
        .from(s)
        .innerJoin(
          schema.grants,
          and(eq(schema.grants.tenantId, s.tenantId), eq(schema.grants.staffMemberId, s.id)),
        )
        .innerJoin(
          schema.roleDefinitions,
          and(
            eq(schema.roleDefinitions.tenantId, schema.grants.tenantId),
            eq(schema.roleDefinitions.id, schema.grants.roleId),
          ),
        )
        .where(
          and(
            eq(s.status, 'active'),
            isNull(schema.grants.revokedAt),
            eq(schema.roleDefinitions.key, 'owner'),
          ),
        );
      const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants);
      const workspace = tenant?.name ?? 'your workspace';
      const senderName = await senderNameOf(tx);
      const manageUrl = `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/settings/billing`;
      const [entitlement] = await tx
        .select({ planName: schema.tenantEntitlements.planName })
        .from(schema.tenantEntitlements);
      const amount = formatMinor(notice.amountMinor, notice.currency);
      for (const owner of owners) {
        if (notice.kind === 'receipt') {
          await sendTemplate(
            this.mailer,
            { to: owner.email, template: 'billing.receipt', senderName },
            {
              kind: 'receipt',
              workspace,
              amount,
              number: notice.number,
              paidAt: formatDate(notice.paidAt),
              plan: entitlement?.planName ?? null,
              invoiceUrl: notice.url,
              manageUrl,
            },
          );
        } else {
          await sendTemplate(
            this.mailer,
            { to: owner.email, template: 'billing.payment_failed', senderName },
            {
              kind: 'payment-failed',
              workspace,
              amount,
              graceEndsAt: notice.graceEndsAt ? formatDate(notice.graceEndsAt) : null,
              payUrl: notice.url,
              manageUrl,
            },
          );
        }
      }
    });
  }
}
