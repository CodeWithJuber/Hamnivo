import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useQuery } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { CheckboxField, SelectField, TextareaField } from '../../components/Fields';
import { ActionError, ListSkeleton } from '../../components/States';
import { accessKeys } from '../../lib/access';
import { api } from '../../lib/api';
import { useMembers, useStudioMutation } from '../../lib/queries';
import { isCancelled, withReauth } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { BulkResult, Member, MemberOffboarding } from '../../lib/types';

const QUEUE = 'queue';

/**
 * Removing a person safely (HNV-22-05): what they hold first, their open conversations reassigned
 * (through the inbox's own bulk action), then the removal itself. The only owner can't be removed.
 */
export function OffboardDialog({
  member,
  onOpenChange,
  onDone,
}: {
  member: Member;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { tenantId } = useTenant();
  const members = useMembers();
  const plan = useQuery({
    queryKey: [tenantId, 'offboarding', member.id],
    queryFn: ({ signal }) =>
      api<MemberOffboarding>(`/v1/admin/members/${member.id}/offboarding`, {
        tenant: tenantId,
        signal,
      }),
    meta: { studio: true },
    staleTime: 0,
  });
  const [reassign, setReassign] = useState(true);
  const [target, setTarget] = useState(QUEUE);
  const [reason, setReason] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reassignError, setReassignError] = useState<unknown>(null);
  const [working, setWorking] = useState(false);

  const remove = useStudioMutation(
    (body: { reason?: string }, tenant) =>
      api<void>(`/v1/admin/members/${member.id}/remove`, { method: 'POST', body, tenant }),
    [accessKeys.members, accessKeys.invitations, accessKeys.roles, accessKeys.audit],
  );

  /** Reassigns in batches of 50 until nothing is left or a batch makes no progress. */
  const reassignAll = async (): Promise<boolean> => {
    let moved = 0;
    for (let round = 0; round < 40; round += 1) {
      const current = await withReauth(() =>
        api<MemberOffboarding>(`/v1/admin/members/${member.id}/offboarding`, { tenant: tenantId }),
      );
      if (current.openConversations.ids.length === 0) break;
      const to =
        target === QUEUE
          ? { kind: 'queue' as const }
          : { kind: 'staff' as const, staffMemberId: target };
      const result = await withReauth(() =>
        api<BulkResult>('/v1/inbox/bulk', {
          method: 'POST',
          tenant: tenantId,
          body: { conversationIds: current.openConversations.ids, action: { type: 'assign', to } },
        }),
      );
      moved += result.summary.done + result.summary.unchanged;
      setProgress(t('access.offboard.reassigned', { n: moved }));
      if (result.summary.failed > 0) {
        setFailure(
          t('access.offboard.reassignFailed', {
            n: result.summary.failed,
            name: member.displayName,
          }),
        );
        return false;
      }
      if (result.summary.done === 0) break;
    }
    return true;
  };

  const submit = async () => {
    setFailure(null);
    setReassignError(null);
    setProgress(null);
    setWorking(true);
    try {
      const data = plan.data;
      if (data && reassign && data.canReassign && data.openConversations.total > 0) {
        setProgress(t('access.offboard.reassigning'));
        try {
          if (!(await reassignAll())) return;
        } catch (error) {
          if (!isCancelled(error)) setReassignError(error);
          return;
        }
      }
      try {
        await remove.mutateAsync(reason.trim() ? { reason: reason.trim() } : {});
      } catch {
        // The removal's own error shows below.
        return;
      }
      const message = t('access.offboard.removed', { name: member.displayName });
      announce(message);
      onDone(message);
      onOpenChange(false);
    } finally {
      setWorking(false);
    }
  };

  const busy = working || remove.isPending;
  const others = (members.data?.items ?? []).filter(
    (m) => m.id !== member.id && m.status === 'active',
  );
  const data = plan.data;

  if (data?.lastOwner) {
    return (
      <AppDialog
        open
        onOpenChange={onOpenChange}
        title={t('access.offboard.ownerTitle')}
        testId="last-owner-dialog"
      >
        <p className="flex items-start gap-3 text-sm text-text">
          <AlertCircleIcon className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
          {t('access.offboard.ownerBody')}
        </p>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{t('access.offboard.goToMembers')}</Button>
        </DialogFooter>
      </AppDialog>
    );
  }

  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!busy) onOpenChange(open);
      }}
      title={t('access.offboard.title', { name: member.displayName })}
      testId="offboard-dialog"
    >
      <div className="flex flex-col gap-4 text-sm text-text">
        <p>{t('access.offboard.body')}</p>
        {plan.isPending ? (
          <div role="status" aria-busy="true" aria-label={t('access.offboard.loading')}>
            <ListSkeleton rows={1} />
          </div>
        ) : data ? (
          <>
            <p data-testid="open-conversations">
              {data.openConversations.total > 0
                ? t('access.offboard.conversations', { n: data.openConversations.total })
                : t('access.offboard.noConversations')}
            </p>
            {data.openConversations.total > 0 ? (
              data.canReassign ? (
                <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                  <CheckboxField
                    id="offboard-reassign"
                    label={t('access.offboard.reassign')}
                    checked={reassign}
                    onCheckedChange={setReassign}
                  />
                  {reassign ? (
                    <SelectField
                      id="offboard-target"
                      label={t('access.offboard.reassignTo')}
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                      options={[
                        { value: QUEUE, label: t('access.offboard.queue') },
                        ...others.map((m) => ({ value: m.id, label: m.displayName })),
                      ]}
                    />
                  ) : null}
                </div>
              ) : (
                <p className="text-text-secondary">{t('access.offboard.cantReassign')}</p>
              )
            ) : null}
          </>
        ) : (
          <ActionError error={plan.error} />
        )}
        <TextareaField
          id="offboard-reason"
          label={t('access.offboard.reason')}
          labelNote={t('app.optional')}
          hint={t('access.offboard.reasonHint')}
          value={reason}
          maxLength={400}
          rows={2}
          onChange={(event) => setReason(event.target.value)}
        />
        {progress ? (
          <p role="status" className="text-text-secondary">
            {progress}
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="font-medium text-danger">
            {failure}
          </p>
        ) : null}
        <ActionError error={reassignError} />
        <ActionError error={isCancelled(remove.error) ? null : remove.error} />
      </div>
      <DialogFooter>
        <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
          {t('app.cancel')}
        </Button>
        <Button
          variant="destructive-solid"
          busy={busy}
          disabled={plan.isPending}
          onClick={() => void submit()}
          data-testid="confirm-remove"
        >
          {t('access.offboard.submit', { name: member.displayName })}
        </Button>
      </DialogFooter>
    </AppDialog>
  );
}
