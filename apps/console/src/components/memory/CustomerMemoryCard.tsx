import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversationMemoryCustomer, useMemoryOf } from '../../lib/ai-power';
import { isApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useTenant } from '../../lib/tenant';
import type { MemoryCustomerDetail, MemoryItem } from '../../lib/types';
import { ConsentBadge, MemoryStatusBadge, SlotIcon, slotLabel, sourceLabel } from '../MemoryBadges';
import { ErrorPanel, ListSkeleton } from '../States';
import { CorrectMemoryDialog, DeleteMemoryDialog } from './MemoryItemDialogs';

type Choice = { kind: 'correct' | 'delete'; item: MemoryItem };

function ConsentLine({ detail }: { detail: MemoryCustomerDetail }) {
  const { t } = useTranslation();
  const { consent } = detail;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ConsentBadge state={consent.state} />
      <span className="text-xs text-text-secondary" data-testid="memory-card-consent">
        {consent.decidedAt && consent.state !== 'undecided'
          ? t(`memory.consent.line.${consent.state}`, { date: formatDateTime(consent.decidedAt) })
          : t('memory.consent.line.undecided')}
      </span>
    </div>
  );
}

function Remembered({
  item,
  customerId,
  conversationId,
  onOpen,
}: {
  item: MemoryItem;
  customerId: string;
  conversationId: string;
  onOpen: (choice: Choice) => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const label = slotLabel(t, item.key);
  const active = item.status === 'active';
  const correctable = active && can('memory.manage');
  const deletable = can('memory.delete');
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-2.5"
      data-memory={item.key}
      data-status={item.status}
    >
      <div className="flex items-start gap-2">
        <SlotIcon slot={item.key} className="mt-0.5 size-4 shrink-0 text-text-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs text-text-secondary">{label}</span>
          <bdi dir="auto" className="text-sm font-medium break-words text-text">
            {item.value}
          </bdi>
          <span className="text-xs text-text-secondary" data-testid="memory-card-source">
            {sourceLabel(t, item)} · {formatDateTime(item.source.observedAt)}
            {item.source.conversationId === conversationId
              ? ` · ${t('aiPower.memoryCard.thisChat')}`
              : ''}
          </span>
          {item.status === 'pending' ? (
            <span className="flex flex-wrap items-center gap-2 pt-0.5">
              <MemoryStatusBadge item={item} />
              <span className="text-xs text-text-secondary">
                {t('aiPower.memoryCard.pendingNote')}
              </span>
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {item.status === 'pending' && can('memory.manage') ? (
          <Link
            to="/memory/$customerId"
            params={{ customerId }}
            search={{ memory: item.id }}
            aria-label={t('aiPower.memoryCard.reviewLabel', { label })}
            className="inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-link underline underline-offset-4 hover:no-underline"
          >
            {t('aiPower.memoryCard.review')}
          </Link>
        ) : null}
        {correctable ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('aiPower.memoryCard.correctLabel', { label })}
            onClick={() => onOpen({ kind: 'correct', item })}
          >
            <PencilIcon aria-hidden="true" />
            {t('aiPower.memoryCard.correct')}
          </Button>
        ) : null}
        {deletable ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('aiPower.memoryCard.deleteLabel', { label })}
            onClick={() => onOpen({ kind: 'delete', item })}
          >
            <Trash2Icon aria-hidden="true" />
            {t('aiPower.memoryCard.delete')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** What is remembered, once the customer is known. */
function Remembers({ customerId, conversationId }: { customerId: string; conversationId: string }) {
  const { t } = useTranslation();
  const memory = useMemoryOf(customerId);
  // The memory a dialog is about stays set while the dialog closes, so focus can go back.
  const [selected, setSelected] = useState<MemoryItem | null>(null);
  const [dialog, setDialog] = useState<Choice['kind'] | null>(null);
  if (memory.error && !memory.data) {
    return (
      <ErrorPanel
        error={memory.error}
        onRetry={() => memory.refetch()}
        retrying={memory.isRefetching}
      />
    );
  }
  if (!memory.data) return <ListSkeleton rows={2} />;
  const detail = memory.data;
  return (
    <>
      <ConsentLine detail={detail} />
      {detail.offered ? null : (
        <p className="text-xs text-text-secondary">{t('aiPower.memoryCard.off')}</p>
      )}
      {detail.items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('aiPower.memoryCard.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="memory-card-items">
          {detail.items.map((item) => (
            <Remembered
              key={item.id}
              item={item}
              customerId={customerId}
              conversationId={conversationId}
              onOpen={(choice) => {
                setSelected(choice.item);
                setDialog(choice.kind);
              }}
            />
          ))}
        </ul>
      )}
      <p className="text-xs text-text-secondary">{t('aiPower.memoryCard.note')}</p>
      {selected ? (
        <>
          <CorrectMemoryDialog
            key={`correct-${selected.id}`}
            item={selected}
            customerId={customerId}
            open={dialog === 'correct'}
            onOpenChange={(next) => !next && setDialog(null)}
          />
          <DeleteMemoryDialog
            key={`delete-${selected.id}`}
            item={selected}
            customerId={customerId}
            open={dialog === 'delete'}
            onOpenChange={(next) => !next && setDialog(null)}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * What the AI remembers about the customer of a conversation, beside the conversation (L04): each
 * memory with where it came from, and for people with the right grants, a correction or a
 * deletion. It uses the memory API as the memory page does, and only a person who may read memory
 * in the conversation's brand sees it at all.
 */
export function CustomerMemoryCard({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const lookup = useConversationMemoryCustomer(conversationId);
  if (!can('memory.read')) return null;
  // A conversation or a brand the person has no memory grant for has no card.
  if (isApiError(lookup.error, 'SCOPE_DENIED') || isApiError(lookup.error, 'NOT_FOUND')) {
    return null;
  }
  const customerId = lookup.data?.customerId ?? null;
  const titleId = `ctx-memory-${conversationId}`;
  return (
    <section
      aria-labelledby={titleId}
      data-testid="customer-memory-card"
      className="flex flex-col gap-3 border-b border-border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={titleId} className="text-sm font-semibold text-text">
          {t('aiPower.memoryCard.title')}
        </h3>
        {customerId ? (
          <Link
            to="/memory/$customerId"
            params={{ customerId }}
            className="text-xs text-link underline underline-offset-4 hover:no-underline"
          >
            {t('aiPower.memoryCard.open')}
          </Link>
        ) : null}
      </div>
      {lookup.error && !lookup.data ? (
        <ErrorPanel
          error={lookup.error}
          onRetry={() => lookup.refetch()}
          retrying={lookup.isRefetching}
        />
      ) : !lookup.data ? (
        <ListSkeleton rows={2} />
      ) : customerId === null ? (
        <p className="text-sm text-text-secondary">{t('aiPower.memoryCard.none')}</p>
      ) : (
        <Remembers customerId={customerId} conversationId={conversationId} />
      )}
    </section>
  );
}
