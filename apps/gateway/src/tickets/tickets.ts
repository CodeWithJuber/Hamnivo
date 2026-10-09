import type { TicketSource, TicketState } from '@hamnivo/contracts';
import { ticketReference } from '@hamnivo/contracts';
import { schema, type TenantTx } from '@hamnivo/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * Tickets (H19): a ticket is a conversation with a number, so its history stays in one place
 * (ADR 0010). The number is the tenant's next one; Closed is the conversation resolved, Pending is
 * snoozed until the customer writes, and Open is everything else.
 */

/** Where a ticket stands, read from its conversation. */
export function ticketStateOf(
  status: 'open' | 'pending' | 'resolved' | 'snoozed',
  snoozedUntil: Date | null,
): TicketState {
  if (status === 'resolved') return 'closed';
  if (status === 'snoozed' && snoozedUntil === null) return 'pending';
  return 'open';
}

/** The tenant's next ticket number (one upsert, so two tickets never share a number). */
async function nextTicketNumber(tx: TenantTx, tenantId: string): Promise<number> {
  const [row] = await tx
    .insert(schema.tenantCounters)
    .values({ tenantId, name: 'ticket', value: 1 })
    .onConflictDoUpdate({
      target: [schema.tenantCounters.tenantId, schema.tenantCounters.name],
      set: { value: sql`${schema.tenantCounters.value} + 1` },
    })
    .returning({ value: schema.tenantCounters.value });
  if (!row) throw new Error('ticket counter returned nothing');
  return row.value;
}

/**
 * Makes the conversation a ticket, or returns the number it already has: a conversation never
 * gets a second number, whoever asks.
 */
export async function makeTicket(
  tx: TenantTx,
  tenantId: string,
  conversationId: string,
  source: TicketSource,
  now: Date,
): Promise<{ number: number; created: boolean }> {
  const s = schema.conversationInboxState;
  const [existing] = await tx
    .select({ number: s.ticketNumber })
    .from(s)
    .where(eq(s.conversationId, conversationId))
    .for('update');
  if (existing?.number) return { number: existing.number, created: false };
  const number = await nextTicketNumber(tx, tenantId);
  const ticket = { ticketNumber: number, ticketSource: source, ticketOpenedAt: now };
  if (existing) {
    await tx
      .update(s)
      .set({ ...ticket, updatedAt: now })
      .where(and(eq(s.conversationId, conversationId), isNull(s.ticketNumber)));
  } else {
    await tx.insert(s).values({ tenantId, conversationId, ...ticket });
  }
  return { number, created: true };
}

/** A ticket as the customer sees it, from its number and its conversation's state. */
export function customerTicket(
  number: number | null,
  status: 'open' | 'pending' | 'resolved' | 'snoozed',
  snoozedUntil: Date | null,
): { reference: string; state: TicketState } | null {
  return number === null
    ? null
    : { reference: ticketReference(number), state: ticketStateOf(status, snoozedUntil) };
}
