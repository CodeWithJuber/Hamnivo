import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type AiAction,
  type HandoffPacket,
  useConversationActions,
  useHandoffPackets,
} from '../lib/actions';
import { api, newIdempotencyKey } from '../lib/api';
import { formatAmount } from '../lib/commerce';
import { formatDateTime } from '../lib/format';
import { useConversationChange } from '../lib/inbox';
import { isCancelled } from '../lib/reauth';
import { useTenant } from '../lib/tenant';
import { ActionStateBadge } from '../pages/ToolsPage';
import { AppDialog, DialogFooter } from './AppDialog';
import { ChoiceField, TextareaField } from './Fields';
import { ActionError, ErrorPanel, ListSkeleton } from './States';

const path = (conversationId: string, rest: string) =>
  `/v1/inbox/conversations/${encodeURIComponent(conversationId)}${rest}`;

function ResolveDialog({
  open,
  onOpenChange,
  conversationId,
  action,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  action: AiAction;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [outcome, setOutcome] = useState<'succeeded' | 'failed'>('succeeded');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const resolve = useConversationChange(
    conversationId,
    (body: { outcome: 'succeeded' | 'failed'; note: string }, tenant) =>
      api<AiAction>(path(conversationId, `/actions/${action.id}/resolve`), {
        method: 'POST',
        body,
        tenant,
      }),
    ['actions'],
  );
  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!resolve.isPending) onOpenChange(next);
      }}
      title={t('tools.inbox.resolveTitle')}
      description={t('tools.inbox.resolveDescription')}
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (note.trim().length < 3) {
            setError(t('tools.inbox.resolveNoteError'));
            return;
          }
          setError(undefined);
          try {
            await resolve.mutateAsync({ outcome, note: note.trim() });
            announce(t('tools.inbox.resolved'));
            onOpenChange(false);
          } catch {
            // Shown below.
          }
        }}
      >
        <p className="text-sm text-text">
          <bdi>{action.summary}</bdi>
        </p>
        <ChoiceField
          id={`resolve-${action.id}`}
          legend={t('tools.inbox.resolveOutcome')}
          value={outcome}
          onValueChange={(value) => setOutcome(value as 'succeeded' | 'failed')}
          choices={[
            { value: 'succeeded', label: t('tools.inbox.resolveDone') },
            { value: 'failed', label: t('tools.inbox.resolveNotDone') },
          ]}
        />
        <TextareaField
          id={`resolve-note-${action.id}`}
          label={t('tools.inbox.resolveNote')}
          value={note}
          maxLength={300}
          onChange={(event) => setNote(event.target.value)}
          error={error}
        />
        <ActionError error={isCancelled(resolve.error) ? null : resolve.error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={resolve.isPending}>
            {t('tools.inbox.resolveSubmit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function ActionItem({ conversationId, action }: { conversationId: string; action: AiAction }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const [resolveOpen, setResolveOpen] = useState(false);
  // One request id per answer: a repeated tap is the same decision, not a second one.
  const [requestIds] = useState(() => ({
    approve: newIdempotencyKey(),
    decline: newIdempotencyKey(),
  }));
  const decide = useConversationChange(
    conversationId,
    (decision: 'approve' | 'decline', tenant) =>
      api<AiAction>(path(conversationId, `/actions/${action.id}/decision`), {
        method: 'POST',
        body: {
          decision,
          argumentsHash: action.argumentsHash,
          clientRequestId: requestIds[decision],
        },
        tenant,
      }),
    ['actions'],
  );
  const check = useConversationChange(
    conversationId,
    (_: undefined, tenant) =>
      api(path(conversationId, `/actions/${action.id}/check`), { method: 'POST', tenant }),
    ['actions'],
  );
  const approver = can('tools.approve');
  const staffDecides = action.approver === 'staff' && action.state === 'awaiting_approval';
  const failure = [decide.error, check.error].find((e) => e && !isCancelled(e)) ?? null;
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-action={action.tool.name}
      data-state={action.state}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ActionStateBadge state={action.state} />
        <time dateTime={action.createdAt} className="text-xs text-text-secondary">
          {formatDateTime(action.createdAt)}
        </time>
      </div>
      <p className="text-sm font-medium text-text">
        <bdi>{action.summary}</bdi>
      </p>
      {action.changes.length > 0 ? (
        <dl className="flex flex-col gap-1 text-sm">
          {action.changes.map((change) => (
            <div key={change.field} className="flex flex-col">
              <dt className="text-xs text-text-secondary">
                <bdi>{change.field}</bdi>
              </dt>
              <dd className="text-text">
                {change.from !== null ? (
                  <>
                    <span className="sr-only">{t('tools.inbox.from')} </span>
                    <bdi className="text-text-secondary line-through">{change.from}</bdi>
                    <span aria-hidden="true" className="mx-1 inline-block rtl:-scale-x-100">
                      →
                    </span>
                    <span className="sr-only">{t('tools.inbox.to')} </span>
                  </>
                ) : null}
                <bdi>{change.to}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {action.amount ? (
        <p className="text-sm text-text">
          {t('tools.inbox.amount')}:{' '}
          {formatAmount(action.amount.amountMinor, action.amount.currency)}
        </p>
      ) : null}
      {action.outcome ? (
        <p className="text-sm text-text">
          <bdi>{action.outcome}</bdi>
        </p>
      ) : null}
      {action.reason && action.state !== 'completed' ? (
        <p className="text-xs text-text-secondary">
          <bdi>{action.reason}</bdi>
        </p>
      ) : null}
      {action.receipt ? (
        <p className="text-xs text-text-secondary">
          {t('tools.inbox.receipt', {
            outcome: t(`tools.inbox.receiptOutcomes.${action.receipt.outcome}`),
          })}
          {action.receipt.reference ? ` · ${action.receipt.reference}` : ''}
          {` · ${formatDateTime(action.receipt.observedAt)}`}
        </p>
      ) : null}
      {action.decision ? (
        <p className="text-xs text-text-secondary">
          {t('tools.inbox.decided', {
            decision: t(`tools.inbox.decisions.${action.decision.decision}`),
            who: t(`tools.log.by.${action.decision.approverKind}`),
            time: formatDateTime(action.decision.at),
          })}
        </p>
      ) : null}
      {action.state === 'awaiting_approval' ? (
        <p className="text-xs text-text-secondary">
          {action.approver === 'customer'
            ? t('tools.inbox.customerApproves')
            : action.stepUp
              ? t('tools.inbox.stepUp')
              : t('tools.inbox.staffApproves')}
          {action.expiresAt
            ? ` ${t('tools.inbox.expires', { time: formatDateTime(action.expiresAt) })}`
            : ''}
        </p>
      ) : null}
      {action.state === 'unknown' ? (
        <p className="text-sm font-medium text-warning" role="note">
          {t('tools.inbox.notConfirmed')}
        </p>
      ) : null}
      <ActionError error={failure} />
      {approver && staffDecides ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            busy={decide.isPending && decide.variables === 'approve'}
            disabled={decide.isPending}
            onClick={async () => {
              try {
                await decide.mutateAsync('approve');
                announce(t('tools.inbox.approved'));
              } catch {
                // Shown above.
              }
            }}
          >
            {t('tools.inbox.approve')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            busy={decide.isPending && decide.variables === 'decline'}
            disabled={decide.isPending}
            onClick={async () => {
              try {
                await decide.mutateAsync('decline');
                announce(t('tools.inbox.declined'));
              } catch {
                // Shown above.
              }
            }}
          >
            {t('tools.inbox.decline')}
          </Button>
        </div>
      ) : null}
      {approver && action.state === 'unknown' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            busy={check.isPending}
            onClick={async () => {
              try {
                await check.mutateAsync();
                announce(t('tools.inbox.checking'));
              } catch {
                // Shown above.
              }
            }}
          >
            <RefreshCwIcon aria-hidden="true" />
            {t('tools.inbox.check')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setResolveOpen(true)}>
            {t('tools.inbox.resolve')}
          </Button>
          <ResolveDialog
            open={resolveOpen}
            onOpenChange={setResolveOpen}
            conversationId={conversationId}
            action={action}
          />
        </div>
      ) : null}
    </li>
  );
}

/** What the AI did and what is open in this conversation (G13, G14; HNV-13-02/05). */
export function ConversationActions({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const actions = useConversationActions(conversationId);
  if (actions.error && !actions.data) {
    return (
      <ErrorPanel
        error={actions.error}
        onRetry={() => actions.refetch()}
        retrying={actions.isRefetching}
      />
    );
  }
  if (!actions.data) return <ListSkeleton rows={1} />;
  if (actions.data.items.length === 0) {
    return <p className="text-sm text-text-secondary">{t('tools.inbox.empty')}</p>;
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="conversation-actions">
      {actions.data.items.map((action) => (
        <ActionItem key={action.id} conversationId={conversationId} action={action} />
      ))}
    </ul>
  );
}

function PacketView({ packet }: { packet: HandoffPacket }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="handoff-packet">
      <p className="text-text">
        <bdi>{packet.reasonText}</bdi>
      </p>
      {packet.request ? (
        <div>
          <p className="text-xs text-text-secondary">{t('tools.handoff.request')}</p>
          <blockquote className="text-text">
            <bdi>“{packet.request}”</bdi>
          </blockquote>
        </div>
      ) : null}
      {packet.attempts.length > 0 ? (
        <div>
          <p className="text-xs text-text-secondary">{t('tools.handoff.attempts')}</p>
          <ul className="list-disc ps-5 text-text">
            {packet.attempts.map((attempt, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: attempts are in the order they happened
              <li key={index}>
                <bdi>{attempt.label}</bdi>: <bdi>{attempt.outcome}</bdi>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {packet.pending.length > 0 ? (
        <div>
          <p className="text-xs text-text-secondary">{t('tools.handoff.pending')}</p>
          <ul className="list-disc ps-5 text-text">
            {packet.pending.map((item) => (
              <li key={item.actionId}>
                <bdi>{item.title}</bdi> · {t(`tools.handoff.pendingStates.${item.state}`)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {packet.facts.length > 0 ? (
        <div>
          <p className="text-xs text-text-secondary">{t('tools.handoff.facts')}</p>
          <ul className="flex flex-col gap-1 text-text">
            {packet.facts.map((fact, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: facts are listed in recorded order
              <li key={index}>
                <span className="font-medium">
                  <bdi>{fact.label}</bdi>:
                </span>{' '}
                <bdi>{fact.value}</bdi>{' '}
                <span className="text-xs text-text-secondary">
                  ({t(`tools.handoff.sources.${fact.source.kind}`)}
                  {fact.source.observedAt ? `, ${formatDateTime(fact.source.observedAt)}` : ''})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-xs text-text-secondary">
        {t('tools.handoff.recorded', { time: formatDateTime(packet.createdAt) })}
      </p>
    </div>
  );
}

/** The latest handoff packet (G10, HNV-10-03): recorded facts, never hidden reasoning. */
export function HandoffSummary({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const packets = useHandoffPackets(conversationId);
  if (packets.error && !packets.data) {
    return (
      <ErrorPanel
        error={packets.error}
        onRetry={() => packets.refetch()}
        retrying={packets.isRefetching}
      />
    );
  }
  if (!packets.data) return <ListSkeleton rows={1} />;
  const latest = packets.data.items[0];
  if (!latest) return <p className="text-sm text-text-secondary">{t('tools.handoff.none')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <StatusBadge tone="info" className="self-start">
        {t('tools.handoff.epoch', { epoch: latest.epoch })}
      </StatusBadge>
      <PacketView packet={latest} />
    </div>
  );
}
