import { PartialFailure } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { Input } from '@hamnivo/ui/components/input';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { ActionError } from '../../components/States';
import { api } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { type BulkResult, type InboxConversation, inboxKeys } from '../../lib/inbox';
import { withReauth } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';

type BulkAction =
  | { type: 'assign'; to: { kind: 'me' } }
  | { type: 'status'; status: 'resolved' | 'open' }
  | { type: 'tags'; add: string[]; remove: string[] };

/**
 * Changes to many conversations at once (H15, HNV-08-04). A dry run first says which ones the
 * change would reach; each conversation is then checked and changed on its own, and failures are
 * listed with their reason and can be retried alone.
 */
export function BulkBar({
  ids,
  rows,
  onDone,
  onClear,
}: {
  ids: string[];
  rows: InboxConversation[];
  onDone: (failed: string[]) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const [action, setAction] = useState<BulkAction | null>(null);
  const [preview, setPreview] = useState<BulkResult | null>(null);
  const [outcome, setOutcome] = useState<BulkResult | null>(null);
  const [applied, setApplied] = useState<BulkAction | null>(null);
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const names = new Map(rows.map((r) => [r.id, r.customer.displayName]));

  const run = (next: BulkAction, conversationIds: string[], dryRun: boolean) =>
    withReauth(() =>
      api<BulkResult>('/v1/inbox/bulk', {
        method: 'POST',
        tenant: tenantId,
        body: { conversationIds, action: next, dryRun },
      }),
    );

  const start = async (next: BulkAction) => {
    setError(null);
    setOutcome(null);
    setBusy(true);
    try {
      setPreview(await run(next, ids, true));
      setAction(next);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (change: BulkAction | null, conversationIds: string[]) => {
    if (!change) return;
    setBusy(true);
    setError(null);
    try {
      const result = await run(change, conversationIds, false);
      setOutcome(result);
      setApplied(change);
      setAction(null);
      setPreview(null);
      const failed = result.results
        .filter((r) => r.outcome === 'failed')
        .map((r) => r.conversationId);
      announce(
        t('inbox.bulk.result', {
          done: result.summary.done + result.summary.unchanged,
          failed: result.summary.failed,
        }),
      );
      onDone(failed);
      await client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.all] });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const eligible = preview?.results.filter((r) => r.outcome === 'eligible') ?? [];
  const refused = preview?.results.filter((r) => r.outcome === 'failed') ?? [];
  const failed = outcome?.results.filter((r) => r.outcome === 'failed') ?? [];

  return (
    <section
      aria-labelledby="bulk-title"
      className="flex flex-col gap-2 border-b border-border bg-surface-muted p-3"
      data-testid="bulk-bar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="bulk-title" className="text-sm font-semibold text-text">
          {t('inbox.bulk.count', { n: ids.length })}
        </h2>
        <Button variant="ghost" size="sm" className="ms-auto" onClick={onClear}>
          <XIcon aria-hidden="true" />
          {t('inbox.bulk.clear')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          busy={busy}
          onClick={() => start({ type: 'assign', to: { kind: 'me' } })}
        >
          {t('inbox.bulk.assignMe')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          busy={busy}
          onClick={() => start({ type: 'status', status: 'resolved' })}
        >
          {t('inbox.bulk.resolve')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          busy={busy}
          onClick={() => start({ type: 'status', status: 'open' })}
        >
          {t('inbox.bulk.reopen')}
        </Button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (tag.trim()) void start({ type: 'tags', add: [tag.trim()], remove: [] });
        }}
      >
        <Input
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          aria-label={t('inbox.bulk.tagLabel')}
          placeholder={t('inbox.bulk.tagPlaceholder')}
          className="h-9"
          dir={tag ? 'auto' : undefined}
        />
        <Button type="submit" size="sm" variant="secondary" busy={busy}>
          {t('inbox.bulk.addTag')}
        </Button>
      </form>
      <ActionError error={error} />
      {outcome && failed.length > 0 ? (
        <PartialFailure
          succeeded={outcome.summary.done + outcome.summary.unchanged}
          failed={failed.length}
          summary={t('inbox.bulk.partial', {
            done: outcome.summary.done + outcome.summary.unchanged,
            failed: failed.length,
          })}
          retryFailedLabel={t('inbox.bulk.retryFailed')}
          onRetryFailed={() =>
            void apply(
              applied,
              failed.map((f) => f.conversationId),
            )
          }
        />
      ) : null}
      {outcome && failed.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-text-secondary" data-testid="bulk-failures">
          {failed.map((f) => (
            <li key={f.conversationId}>
              <bdi className="font-medium text-text">
                {names.get(f.conversationId) ?? f.conversationId}
              </bdi>
              {': '}
              {f.detail ?? t('inbox.bulk.failed')}
            </li>
          ))}
        </ul>
      ) : null}

      <AppDialog
        open={Boolean(action && preview)}
        onOpenChange={(next) => {
          if (!next && !busy) {
            setAction(null);
            setPreview(null);
          }
        }}
        title={t('inbox.bulk.confirmTitle')}
        testId="bulk-confirm"
      >
        <div className="flex flex-col gap-2 text-sm text-text">
          <p>{t('inbox.bulk.willChange', { n: eligible.length })}</p>
          {refused.length > 0 ? (
            <>
              <p className="font-medium">{t('inbox.bulk.cannotChange', { n: refused.length })}</p>
              <ul className="flex list-disc flex-col gap-1 ps-5 text-text-secondary">
                {refused.map((r) => (
                  <li key={r.conversationId}>
                    <bdi>{names.get(r.conversationId) ?? r.conversationId}</bdi>:{' '}
                    {r.detail ?? r.code}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        <ActionError error={error} />
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setAction(null);
              setPreview(null);
            }}
          >
            {t('app.cancel')}
          </Button>
          <Button
            busy={busy}
            disabled={eligible.length === 0}
            onClick={() =>
              void apply(
                action,
                eligible.map((r) => r.conversationId),
              )
            }
          >
            {t('inbox.bulk.apply', { n: formatNumber(eligible.length) })}
          </Button>
        </DialogFooter>
      </AppDialog>
    </section>
  );
}
