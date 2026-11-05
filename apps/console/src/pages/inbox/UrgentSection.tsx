import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { SirenIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError } from '../../components/States';
import { isApiError } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import {
  assign,
  type InboxConversation,
  type InboxSearch,
  useConversationChange,
} from '../../lib/inbox';
import { useUrgent } from '../../lib/sla';
import { useTenant } from '../../lib/tenant';
import { formatWaited, lostClaimText, SlaBadge } from './parts';

/** The urgent conversations shown at once; the rest wait in the queue below. */
const SHOWN = 5;

const REASONS = new Set([
  'customer_request',
  'ai_escalated',
  'ai_unavailable',
  'ai_blocked',
  'ai_limit',
  'staff_release',
  'channel_ai_off',
  'sla_moved',
]);

function UrgentRow({
  conversation,
  onLost,
}: {
  conversation: InboxConversation;
  onLost: (text: string | null) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const navigate = useNavigate();
  const name = conversation.customer.displayName;
  const claim = useConversationChange(
    conversation.id,
    (_: undefined, tenantId) =>
      assign(tenantId, conversation.id, { kind: 'me' }, conversation.ownershipEpoch),
    ['messages'],
  );
  const reason =
    conversation.ownerReason && REASONS.has(conversation.ownerReason)
      ? conversation.ownerReason
      : 'other';
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-surface px-3 py-2"
      data-urgent-id={conversation.id}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          to="/inbox/$conversationId"
          params={{ conversationId: conversation.id }}
          search={(prev: InboxSearch) => prev}
          className="truncate font-medium text-text underline-offset-4 hover:underline"
        >
          <bdi>{name}</bdi>
        </Link>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
          {conversation.sla ? <SlaBadge sla={conversation.sla} /> : null}
          <span>{t(`inbox.sla.urgent.reason.${reason}` as 'inbox.sla.urgent.reason.other')}</span>
          {conversation.waitingSince ? (
            <span>
              {t('inbox.sla.urgent.waited', { time: formatWaited(conversation.waitingSince) })}
            </span>
          ) : null}
        </span>
      </div>
      <Button
        size="sm"
        busy={claim.isPending}
        aria-label={t('inbox.sla.urgent.claimName', { name })}
        onClick={async () => {
          onLost(null);
          // Awaited rather than per-call callbacks: the list reloads after the claim either way,
          // and the row leaves it before such callbacks would run.
          try {
            await claim.mutateAsync(undefined);
          } catch (error) {
            // The section keeps who won, as this row is gone once the list reloads.
            if (isApiError(error, 'OWNERSHIP_CHANGED')) {
              onLost(lostClaimText(error.problem?.currentOwner, t));
            }
            return;
          }
          announce(t('inbox.sla.urgent.claimed', { name }));
          void navigate({
            to: '/inbox/$conversationId',
            params: { conversationId: conversation.id },
            search: (prev: InboxSearch) => prev,
          });
        }}
        data-testid="urgent-claim"
      >
        {t('inbox.sla.urgent.claim')}
      </Button>
      {claim.error && !isApiError(claim.error, 'OWNERSHIP_CHANGED') ? (
        <div className="basis-full">
          <ActionError error={claim.error} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Urgent conversations waiting for a person that nobody has taken (HNV-08-02), above the queue,
 * soonest deadline first, each with a Claim button. A claim that loses says who won (HNV-08-06).
 * Shown to people who can take conversations, and not over the AI or tickets queues or a search.
 */
export function UrgentSection() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/inbox' });
  const [lost, setLost] = useState<string | null>(null);
  const show =
    can('conversations.takeover') &&
    !search.q &&
    search.queue !== 'ai' &&
    search.queue !== 'tickets';
  const urgent = useUrgent(show);
  const items = urgent.data?.items ?? [];
  const total = urgent.data?.total ?? 0;
  if (!show || (items.length === 0 && !lost)) return null;
  const shown = items.slice(0, SHOWN);
  return (
    <section
      aria-labelledby="urgent-heading"
      className="flex flex-col gap-2 border-b border-danger/30 bg-danger-subtle p-3"
      data-testid="urgent-section"
    >
      <h2 id="urgent-heading" className="flex items-center gap-2 text-sm font-semibold text-text">
        <SirenIcon className="size-4 shrink-0 text-danger" aria-hidden="true" />
        {t('inbox.sla.urgent.title')}
        {total > 0 ? (
          <StatusBadge tone="danger" icon={null}>
            {t('inbox.sla.urgent.count', { n: formatNumber(total) })}
          </StatusBadge>
        ) : null}
      </h2>
      {lost ? (
        <p role="alert" className="text-sm font-medium text-text" data-testid="urgent-lost">
          <bdi>{lost}</bdi>
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-labelledby="urgent-heading">
          {shown.map((conversation) => (
            <UrgentRow key={conversation.id} conversation={conversation} onLost={setLost} />
          ))}
        </ul>
      ) : null}
      {total > shown.length ? (
        <p className="text-xs text-text-secondary">
          {t('inbox.sla.urgent.more', {
            shown: formatNumber(shown.length),
            total: formatNumber(total),
          })}
        </p>
      ) : null}
    </section>
  );
}
