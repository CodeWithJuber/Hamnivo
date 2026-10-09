import { z } from 'zod';

/**
 * Tickets (H19). A ticket is a conversation that carries a reference number, a state and a
 * priority, so the history stays in one place (ADR 0010). The state is read from the
 * conversation: Closed is resolved, Pending waits for the customer (snoozed until they write), and
 * Open is everything else.
 */
export const TicketState = z.enum(['open', 'pending', 'closed']);
export type TicketState = z.infer<typeof TicketState>;

/** Chatwoot's priorities, most urgent first. */
export const TICKET_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export const TicketPriority = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPriority>;

/** How the conversation became a ticket. */
export const TicketSource = z.enum(['offline_form', 'staff', 'automation']);
export type TicketSource = z.infer<typeof TicketSource>;

/** A ticket's reference as people quote it. */
export const ticketReference = (number: number): string => `#${number}`;
