import type { Card } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { price, time } from '../commerce/format.js';
import { type ActionProblem, useActionsController } from './useActions.js';

type ApprovalCard = Extract<Card, { kind: 'approval' }>;
type ReceiptCard = Extract<Card, { kind: 'receipt' }>;

const box = 'w-full max-w-[92%] rounded-2xl border border-border bg-surface p-3 text-sm text-text';

const PROBLEM_KEYS: Record<ActionProblem, string> = {
  identity: 'actions.identity',
  mismatch: 'actions.mismatch',
  expired: 'actions.expired',
  gone: 'actions.superseded',
  error: 'actions.error',
};

/**
 * An AI action waiting for the customer's approval (W16): what will happen in plain words, the
 * exact change and amount, who asked (an AI) and until when, with Approve and Decline. Nothing is
 * approvable unless the live request still waits for this customer and carries the card's hash.
 */
export function ApprovalCardView(props: { card: ApprovalCard; locale: string; fallback: string }) {
  const { t } = useTranslation();
  const { card, locale } = props;
  const controller = useActionsController();
  const titleId = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const live = controller?.action(card.approvalId);
  const ensure = controller?.ensure;

  useEffect(() => {
    void ensure?.(card.approvalId);
  }, [card.approvalId, ensure]);

  if (!controller) {
    return (
      <p dir="auto" className="text-sm text-text-muted">
        {props.fallback}
      </p>
    );
  }
  const problem = controller.problems[card.approvalId];
  const verified = live !== undefined && live.argumentsHash === card.argumentsHash;
  const waiting = live?.state === 'awaiting_approval';
  const expired = waiting && new Date(card.expiresAt).getTime() <= Date.now();
  const approvable = verified && waiting && !expired && card.approver === 'customer';
  const busy = controller.busy === card.approvalId;

  const statusLine = (() => {
    if (busy) return t('actions.sending');
    if (!live) return t('actions.loading');
    if (!verified) return t('actions.unverified');
    if (problem && (waiting || problem === 'identity')) return t(PROBLEM_KEYS[problem]);
    switch (live.state) {
      case 'awaiting_approval':
        return expired ? t('actions.expired') : t('actions.nothingYet');
      case 'approved':
        return t('actions.approved');
      case 'executing':
        return t('actions.inProgress');
      case 'completed':
        return t('actions.finished');
      case 'failed':
        return t('actions.notDone');
      case 'unknown':
        return t('actions.checking');
      case 'declined':
        return t('actions.declined');
      case 'expired':
        return t('actions.expired');
      default:
        return t('actions.superseded');
    }
  })();

  // The buttons go away once answered: focus moves to the status line, which reads the outcome.
  const answer = async (decision: 'approve' | 'decline') => {
    await controller.decide(card.approvalId, card.argumentsHash, decision);
    statusRef.current?.focus();
  };

  return (
    <section
      className={box}
      aria-labelledby={titleId}
      data-card="approval"
      data-state={live?.state ?? 'loading'}
    >
      <p className="text-xs font-medium text-text-secondary">{t('actions.approvalNeeded')}</p>
      <h2 id={titleId} className="mt-0.5 font-semibold" dir="auto">
        {card.title}
      </h2>
      <p className="mt-1" dir="auto">
        {card.actionSummary}
      </p>
      {card.requestedBy ? (
        <p className="mt-1 text-xs text-text-muted" dir="auto">
          {t('actions.requestedBy', { name: card.requestedBy })}
        </p>
      ) : null}
      {card.changes.length > 0 ? (
        <dl className="mt-2 flex flex-col gap-2" aria-label={t('actions.field')}>
          {card.changes.map((change) => (
            <div key={change.field} className="rounded-lg bg-surface-sunken p-2">
              <dt className="text-xs font-medium text-text-secondary" dir="auto">
                {change.field}
              </dt>
              <dd className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                {change.from !== null ? (
                  <>
                    <span>
                      <span className="sr-only">{t('actions.now')}: </span>
                      <span className="text-text-muted line-through" dir="auto">
                        {change.from}
                      </span>
                    </span>
                    <span
                      className="inline-block text-text-muted rtl:-scale-x-100"
                      aria-hidden="true"
                    >
                      →
                    </span>
                  </>
                ) : null}
                <span>
                  <span className="sr-only">{t('actions.new')}: </span>
                  <span className="font-medium" dir="auto">
                    {change.to}
                  </span>
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {card.amount ? (
        <p className="mt-2 flex justify-between gap-2 font-semibold">
          <span>{t('actions.amount')}</span>
          <span className="tabular-nums">
            {price(card.amount.amountMinor, card.amount.currency, locale)}
          </span>
        </p>
      ) : null}
      {card.effects.length > 0 ? (
        <>
          <h3 className="mt-2 text-xs font-medium text-text-secondary">
            {t('actions.willHappen')}
          </h3>
          <ul className="mt-1 list-disc ps-5 text-xs" dir="auto">
            {card.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        </>
      ) : null}
      {waiting && !expired ? (
        <p className="mt-2 text-xs text-text-muted">
          {t('actions.approveBy', { time: time(card.expiresAt, locale) })}
        </p>
      ) : null}
      {card.stepUp && waiting ? (
        <p className="mt-1 text-xs text-text-muted">{t('actions.identityNote')}</p>
      ) : null}
      <p
        ref={statusRef}
        tabIndex={-1}
        className="mt-2 outline-none"
        role="status"
        data-testid="approval-status"
        dir="auto"
      >
        {statusLine}
      </p>
      {approvable ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="lg"
            className="min-w-0 flex-1"
            disabled={busy}
            onClick={() => void answer('approve')}
          >
            {t('actions.approve')}
          </Button>
          <Button
            size="lg"
            variant="secondary"
            className="min-w-0 flex-1"
            disabled={busy}
            onClick={() => void answer('decline')}
          >
            {t('actions.decline')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Outcome words (never colour alone): the receipt says what happened in text. */
const OUTCOMES: Record<ReceiptCard['outcome'], string> = {
  completed: 'actions.done',
  failed: 'actions.failed',
  unknown: 'actions.unknown',
  cancelled: 'actions.cancelled',
};

/** What an AI action did, shown only from a receipt Hamnivo holds (G14). */
export function ActionReceipt(props: { card: ReceiptCard; locale: string }) {
  const { t } = useTranslation();
  const { card } = props;
  const outcome = OUTCOMES[card.outcome];
  const titleId = useId();
  return (
    <section
      className={box}
      aria-labelledby={titleId}
      data-card="action-receipt"
      data-outcome={card.outcome}
    >
      <h2 id={titleId} className="font-semibold">
        {t('actions.result')}: {t(outcome)}
      </h2>
      <p className="mt-1" dir="auto">
        {card.summary}
      </p>
      {card.outcome === 'unknown' ? (
        <p className="mt-1 text-xs text-text-muted">{t('actions.checking')}</p>
      ) : null}
      {card.reference ? (
        <p className="mt-1 text-xs text-text-muted" dir="auto">
          {t('actions.reference', { reference: card.reference })}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-text-muted">{time(card.occurredAt, props.locale)}</p>
    </section>
  );
}
