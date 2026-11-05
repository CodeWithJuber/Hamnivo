import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { HandshakeIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { ChoiceField, TextareaField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import { isApiError } from '../../lib/api';
import type { InboxConversation, InboxSearch } from '../../lib/inbox';
import {
  formatCountdown,
  type InboxOffer,
  OFFER_DECLINE_REASONS,
  type OfferDeclineReason,
  useAcceptOffer,
  useDeclineOffer,
  useMyOffers,
  useSecondsLeft,
} from '../../lib/offers';
import { useTenant } from '../../lib/tenant';
import { lostClaimText } from './parts';

/** Why an offer could not be accepted or declined: who has the chat now, or that it closed. */
function closedText(error: unknown, t: TFunction): string | null {
  if (!isApiError(error, 'OFFER_CLOSED') && !isApiError(error, 'OWNERSHIP_CHANGED')) return null;
  const owner = error.problem?.currentOwner;
  return owner && owner.kind !== 'none' ? lostClaimText(owner, t) : t('inbox.offers.closed');
}

function DeclineDialog({
  open,
  onOpenChange,
  conversation,
  offer,
  onDeclined,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: InboxConversation;
  offer: InboxOffer;
  onDeclined: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<OfferDeclineReason | ''>('');
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);
  const decline = useDeclineOffer();

  // Each opening is a new answer: fresh fields.
  useEffect(() => {
    if (!open) return;
    setReason('');
    setNote('');
    setAttempted(false);
    decline.reset();
  }, [open, decline.reset]);

  const missing = attempted && !reason;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!reason) return;
    try {
      await decline.mutateAsync({
        offerId: offer.id,
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onOpenChange(false);
      onDeclined();
    } catch {
      // Shown in the dialog.
    }
  };
  const closed = closedText(decline.error, t);

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!decline.isPending) onOpenChange(next);
      }}
      title={t('inbox.offers.declineDialog.title')}
      description={t('inbox.offers.declineDialog.description')}
      testId="decline-offer-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <p className="text-sm font-medium text-text">
          <bdi>{conversation.customer.displayName}</bdi>
        </p>
        <FormErrorSummary
          title={t('auth.errorSummary')}
          errors={
            missing
              ? [
                  {
                    fieldId: 'decline-reason',
                    message: t('inbox.offers.declineDialog.reasonMissing'),
                  },
                ]
              : []
          }
        />
        <ChoiceField
          id="decline-reason"
          legend={t('inbox.offers.declineDialog.reason')}
          value={reason}
          onValueChange={(value) => setReason(value as OfferDeclineReason)}
          error={missing ? t('inbox.offers.declineDialog.reasonMissing') : undefined}
          choices={OFFER_DECLINE_REASONS.map((value) => ({
            value,
            label: t(`inbox.offers.declineDialog.reasons.${value}`),
            ...(value === 'going_offline'
              ? { hint: t('inbox.offers.declineDialog.goingOfflineHint') }
              : {}),
          }))}
        />
        <TextareaField
          id="decline-note"
          label={t('inbox.offers.declineDialog.note')}
          labelNote={t('app.optional')}
          hint={t('inbox.offers.declineDialog.noteHint')}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
        {closed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            <bdi>{closed}</bdi>
          </p>
        ) : (
          <ActionError error={decline.error} />
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={decline.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={decline.isPending}>
            {t('inbox.offers.declineDialog.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function OfferCard({
  conversation,
  offer,
  onClosed,
}: {
  conversation: InboxConversation;
  offer: InboxOffer;
  onClosed: (text: string | null) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const navigate = useNavigate();
  const accept = useAcceptOffer();
  const [declining, setDeclining] = useState(false);
  const seconds = useSecondsLeft(offer.expiresAt);
  const name = conversation.customer.displayName;
  const time = formatCountdown(seconds);
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-surface px-3 py-2"
      data-offer-id={offer.id}
      data-testid="offer-card"
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
        {conversation.lastMessage ? (
          <p className="truncate text-sm text-text-secondary">
            <bdi>{conversation.lastMessage.preview}</bdi>
          </p>
        ) : null}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
          {/* A timer is not announced as it ticks; its name says what the number means. */}
          <span
            role="timer"
            className={`font-medium tabular-nums ${seconds <= 10 ? 'text-danger' : 'text-text'}`}
            aria-label={
              seconds > 0 ? t('inbox.offers.timeLeftLabel', { time }) : t('inbox.offers.timeUp')
            }
            data-testid="offer-countdown"
          >
            {seconds > 0 ? t('inbox.offers.timeLeft', { time }) : t('inbox.offers.timeUp')}
          </span>
          <span>{t('inbox.offers.round', { round: offer.round })}</span>
          {conversation.team ? (
            <span>{t('inbox.row.team', { name: conversation.team.name })}</span>
          ) : null}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          aria-label={t('inbox.offers.declineName', { name })}
          disabled={accept.isPending}
          onClick={() => setDeclining(true)}
          data-testid="offer-decline"
        >
          {t('inbox.offers.decline')}
        </Button>
        <Button
          size="sm"
          busy={accept.isPending}
          aria-label={t('inbox.offers.acceptName', { name })}
          onClick={async () => {
            onClosed(null);
            // Awaited: the list reloads after the answer, and this card leaves it.
            try {
              await accept.mutateAsync(offer.id);
            } catch (error) {
              const closed = closedText(error, t);
              if (closed) onClosed(closed);
              return;
            }
            announce(t('inbox.offers.accepted', { name }));
            void navigate({
              to: '/inbox/$conversationId',
              params: { conversationId: conversation.id },
              search: (prev: InboxSearch) => prev,
            });
          }}
          data-testid="offer-accept"
        >
          {t('inbox.offers.accept')}
        </Button>
      </div>
      {accept.error && !closedText(accept.error, t) ? (
        <div className="basis-full">
          <ActionError error={accept.error} />
        </div>
      ) : null}
      <DeclineDialog
        open={declining}
        onOpenChange={setDeclining}
        conversation={conversation}
        offer={offer}
        onDeclined={() => announce(t('inbox.offers.declined', { name }))}
      />
    </li>
  );
}

/**
 * Chats offered to me (HNV-10-03), above the queue, soonest to run out first: each with the time
 * left, Accept (it becomes mine and opens) and Decline with a reason (it goes to the next person).
 * Shown to people who can take conversations, and not over a search.
 */
export function OffersSection() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/inbox' });
  const [closed, setClosed] = useState<string | null>(null);
  const show = can('conversations.takeover') && !search.q;
  const offers = useMyOffers(show);
  const items = (offers.data?.items ?? []).filter(
    (item): item is InboxConversation & { offer: InboxOffer } => item.offer !== null,
  );
  if (!show || (items.length === 0 && !closed)) return null;
  return (
    <section
      aria-labelledby="offers-heading"
      className="flex flex-col gap-2 border-b border-info/30 bg-info-subtle p-3"
      data-testid="offers-section"
    >
      <h2 id="offers-heading" className="flex items-center gap-2 text-sm font-semibold text-text">
        <HandshakeIcon className="size-4 shrink-0 text-info" aria-hidden="true" />
        {t('inbox.offers.title')}
      </h2>
      <p className="text-xs text-text-secondary">{t('inbox.offers.intro')}</p>
      {closed ? (
        <p role="alert" className="text-sm font-medium text-text" data-testid="offer-closed">
          <bdi>{closed}</bdi>
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-labelledby="offers-heading">
          {items.map((conversation) => (
            <OfferCard
              key={conversation.offer.id}
              conversation={conversation}
              offer={conversation.offer}
              onClosed={setClosed}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
