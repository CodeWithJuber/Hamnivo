import type { CustomerConversation } from '@hamnivo/contracts';
import { TicketIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ticketWords } from '../tickets.js';
import { BidiText } from './BidiText.js';

/** A conversation's ticket (H19): its reference and where it stands, in the customer's words. */
export function TicketLine({
  ticket,
  className = '',
}: {
  ticket: NonNullable<CustomerConversation['ticket']>;
  className?: string;
}) {
  const { t } = useTranslation();
  const words = ticketWords(t, ticket);
  return (
    <span
      className={`inline-flex items-start gap-1 ${className}`}
      data-testid="ticket"
      data-state={ticket.state}
    >
      <TicketIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        <BidiText text={words.label} />
        {` · ${words.state}`}
      </span>
    </span>
  );
}
