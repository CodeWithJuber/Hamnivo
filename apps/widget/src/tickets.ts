import type { CustomerConversation, TicketState } from '@hamnivo/contracts';
import type { TFunction } from 'i18next';

/**
 * A ticket as the customer reads it (H19): its reference and where it stands, in their words.
 * Pending means the team waits for the customer's answer.
 */
const STATE_KEYS: Record<TicketState, string> = {
  open: 'surface.tickets.open',
  pending: 'surface.tickets.pending',
  closed: 'surface.tickets.closed',
};

export function ticketWords(
  t: TFunction,
  ticket: NonNullable<CustomerConversation['ticket']>,
): { label: string; state: string } {
  return {
    label: t('surface.tickets.label', { reference: ticket.reference }),
    state: t(STATE_KEYS[ticket.state]),
  };
}
