import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { Textarea } from '@hamnivo/ui/components/textarea';
import type { TFunction } from 'i18next';
import { CheckIcon, PencilIcon, SendIcon, SparklesIcon, XIcon } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { ChoiceField, TextareaField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import {
  type AiDraft,
  type AiDraftRejectReason,
  approveAiDraft,
  REJECT_REASONS,
  rejectAiDraft,
  useAiDrafts,
} from '../../lib/ai-drafts';
import { isApiError } from '../../lib/api';
import { type InboxDetail, newClientId, useConversationChange } from '../../lib/inbox';
import { isCancelled } from '../../lib/reauth';
import { useReplyWindow } from './Composer';
import { ownership } from './ConversationPane';
import { lostClaimText, useMyStaffId } from './parts';
import { SourceList } from './SourceList';

const REFRESH = ['messages', 'ai-drafts', 'drafts'] as const;

/** What a refused decision says, in the reviewer's words; null for the generic error box. */
function refusalText(error: unknown, t: TFunction): string | null {
  if (isApiError(error, 'OWNERSHIP_CHANGED')) return lostClaimText(error.problem?.currentOwner, t);
  if (isApiError(error, 'AI_DRAFT_CLOSED')) {
    const name = error.problem?.aiDraft?.decidedBy;
    return name ? t('inbox.aiDrafts.closedBy', { name }) : t('inbox.aiDrafts.closed');
  }
  if (isApiError(error, 'CHANNEL_WINDOW_CLOSED')) return t('channels.reply.closed');
  return null;
}

function RejectDialog({
  open,
  onOpenChange,
  detail,
  draft,
  onRejected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: InboxDetail;
  draft: AiDraft;
  onRejected: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<AiDraftRejectReason | ''>('');
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);
  const requestId = useRef(newClientId());
  const reject = useConversationChange(
    detail.id,
    (body: { reason: AiDraftRejectReason; note?: string }, tenantId) =>
      rejectAiDraft(tenantId, detail.id, draft.id, {
        clientRequestId: requestId.current,
        ...body,
      }),
    REFRESH,
  );

  // Each opening is a new decision: fresh fields and a fresh request.
  useEffect(() => {
    if (!open) return;
    setReason('');
    setNote('');
    setAttempted(false);
    requestId.current = newClientId();
    reject.reset();
  }, [open, reject.reset]);

  const missing = attempted && !reason;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!reason) return;
    try {
      await reject.mutateAsync({ reason, ...(note.trim() ? { note: note.trim() } : {}) });
      onOpenChange(false);
      onRejected();
    } catch {
      // Shown in the dialog.
    }
  };
  const refusal = reject.error ? refusalText(reject.error, t) : null;

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!reject.isPending) onOpenChange(next);
      }}
      title={t('inbox.aiDrafts.rejectDialog.title')}
      description={t('inbox.aiDrafts.rejectDialog.description')}
      testId="reject-draft-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary
          title={t('auth.errorSummary')}
          errors={
            missing
              ? [
                  {
                    fieldId: 'reject-reason',
                    message: t('inbox.aiDrafts.rejectDialog.reasonMissing'),
                  },
                ]
              : []
          }
        />
        <ChoiceField
          id="reject-reason"
          legend={t('inbox.aiDrafts.rejectDialog.reason')}
          value={reason}
          onValueChange={(value) => setReason(value as AiDraftRejectReason)}
          error={missing ? t('inbox.aiDrafts.rejectDialog.reasonMissing') : undefined}
          choices={REJECT_REASONS.map((value) => ({
            value,
            label: t(`inbox.aiDrafts.rejectDialog.reasons.${value}`),
          }))}
        />
        <TextareaField
          id="reject-note"
          label={t('inbox.aiDrafts.rejectDialog.note')}
          labelNote={t('app.optional')}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
        {refusal ? (
          <p role="alert" className="text-sm font-medium text-text">
            {refusal}
          </p>
        ) : (
          <ActionError error={isCancelled(reject.error) ? null : reject.error} />
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={reject.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" variant="destructive-solid" busy={reject.isPending}>
            {t('inbox.aiDrafts.rejectDialog.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** The pending draft: its words and sources, and what the reviewer can do with it. */
function PendingDraft({ detail, draft }: { detail: InboxDetail; draft: AiDraft }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const me = useMyStaffId();
  const { byOther } = ownership(detail, me);
  const titleId = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.text);
  const [emptyEdit, setEmptyEdit] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  // One request per text: a retry of the same send is the same request, and sends once.
  const request = useRef({ id: newClientId(), text: '' });
  const approve = useConversationChange(
    detail.id,
    (edited: string | undefined, tenantId) => {
      const sent = edited ?? draft.text;
      if (request.current.text !== sent) request.current = { id: newClientId(), text: sent };
      return approveAiDraft(tenantId, detail.id, draft.id, {
        clientRequestId: request.current.id,
        expectedEpoch: detail.ownershipEpoch,
        ...(edited !== undefined ? { text: edited } : {}),
      });
    },
    REFRESH,
  );

  const closesAt = detail.replyWindowClosesAt ?? null;
  const replyWindow = useReplyWindow(detail.channel, closesAt);
  const blocked = !detail.permissions.reply
    ? t('inbox.composer.noReply')
    : byOther
      ? t('inbox.composer.ownedByOther', {
          name:
            detail.owner.kind === 'staff' ? detail.owner.displayName : t('inbox.owner.external'),
        })
      : detail.channel === 'whatsapp' && replyWindow.state === 'closed'
        ? t('channels.reply.closed')
        : null;

  const send = async (edited?: string) => {
    try {
      const result = await approve.mutateAsync(edited);
      announce(
        result.draft.state === 'edited' ? t('inbox.aiDrafts.editedSent') : t('inbox.aiDrafts.sent'),
      );
    } catch {
      // Shown below.
    }
  };
  const sendEdited = () => {
    if (!text.trim()) {
      setEmptyEdit(true);
      editRef.current?.focus();
      return;
    }
    void send(text.trim());
  };
  const refusal = approve.error ? refusalText(approve.error, t) : null;

  return (
    <section
      aria-labelledby={titleId}
      className="mx-4 mb-2 flex flex-col gap-2 rounded-lg border border-info/30 bg-info-subtle p-3"
      data-testid="ai-draft"
      data-draft-id={draft.id}
    >
      <div className="flex items-start gap-2">
        <SparklesIcon className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 id={titleId} className="text-sm font-semibold text-text">
            {t('inbox.aiDrafts.title')}
          </h3>
          <p className="text-xs text-text-secondary">
            {t('inbox.aiDrafts.by', { name: draft.agentName })}
          </p>
        </div>
      </div>
      {editing ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${titleId}-edit`} className="text-xs font-medium text-text-secondary">
            {t('inbox.aiDrafts.editLabel')}
          </label>
          <Textarea
            id={`${titleId}-edit`}
            ref={editRef}
            dir="auto"
            value={text}
            maxLength={10_000}
            rows={4}
            aria-invalid={emptyEdit ? true : undefined}
            aria-describedby={emptyEdit ? `${titleId}-empty` : undefined}
            onChange={(event) => {
              setText(event.target.value);
              setEmptyEdit(false);
            }}
            data-testid="ai-draft-edit"
          />
          {emptyEdit ? (
            <p id={`${titleId}-empty`} className="text-xs text-danger">
              {t('inbox.aiDrafts.emptyEdit')}
            </p>
          ) : null}
        </div>
      ) : (
        <section
          aria-label={t('inbox.aiDrafts.textLabel')}
          // A long draft scrolls inside the card; the region can be reached and read by keyboard.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be focusable
          tabIndex={0}
          className="max-h-48 overflow-y-auto rounded-md text-sm whitespace-pre-wrap text-text focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="ai-draft-text"
        >
          <bdi dir="auto">{draft.text}</bdi>
        </section>
      )}
      <SourceList sources={draft.sources} />
      {refusal ? (
        <p role="alert" className="text-sm font-medium text-text" data-testid="ai-draft-refused">
          {refusal}
        </p>
      ) : (
        <ActionError error={isCancelled(approve.error) ? null : approve.error} />
      )}
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
            <ReasonedAction reason={blocked}>
              <Button
                size="sm"
                busy={approve.isPending}
                onClick={sendEdited}
                data-testid="ai-draft-send-edited"
              >
                <SendIcon className="rtl:-scale-x-100" aria-hidden="true" />
                {t('inbox.aiDrafts.sendEdited')}
              </Button>
            </ReasonedAction>
            <Button
              size="sm"
              variant="secondary"
              disabled={approve.isPending}
              onClick={() => {
                setEditing(false);
                setText(draft.text);
                setEmptyEdit(false);
              }}
            >
              <XIcon aria-hidden="true" />
              {t('inbox.aiDrafts.cancelEdit')}
            </Button>
          </>
        ) : (
          <>
            <ReasonedAction reason={blocked}>
              <Button
                size="sm"
                busy={approve.isPending}
                onClick={() => void send()}
                data-testid="ai-draft-approve"
              >
                <CheckIcon aria-hidden="true" />
                {t('inbox.aiDrafts.approve')}
              </Button>
            </ReasonedAction>
            <ReasonedAction reason={blocked}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setEditing(true);
                  requestAnimationFrame(() => editRef.current?.focus());
                }}
                data-testid="ai-draft-edit-start"
              >
                <PencilIcon aria-hidden="true" />
                {t('inbox.aiDrafts.edit')}
              </Button>
            </ReasonedAction>
            <ReasonedAction reason={blocked}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRejecting(true)}
                data-testid="ai-draft-reject"
              >
                {t('inbox.aiDrafts.reject')}
              </Button>
            </ReasonedAction>
          </>
        )}
      </div>
      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        detail={detail}
        draft={draft}
        onRejected={() => announce(t('inbox.aiDrafts.rejected'))}
      />
    </section>
  );
}

/** How the draft this person was looking at ended, said once. */
function EndedDraft({ draft, onDismiss }: { draft: AiDraft; onDismiss: () => void }) {
  const { t } = useTranslation();
  const name = draft.decidedBy?.displayName ?? '';
  const text =
    draft.state === 'superseded'
      ? t(`inbox.aiDrafts.ended.${draft.supersededReason ?? 'replaced'}`)
      : draft.state === 'rejected'
        ? t('inbox.aiDrafts.ended.rejected', {
            name,
            reason: t(`inbox.aiDrafts.rejectDialog.reasons.${draft.rejectReason ?? 'other'}`),
          })
        : t(`inbox.aiDrafts.ended.${draft.state === 'edited' ? 'edited' : 'approved'}`, { name });
  return (
    <div
      role="status"
      className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-text-secondary"
      data-testid="ai-draft-ended"
      data-state={draft.state}
    >
      <SparklesIcon className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <bdi>{text}</bdi>
      </p>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {t('inbox.aiDrafts.ended.dismiss')}
      </Button>
    </div>
  );
}

/**
 * The AI draft of a conversation (HNV-09-05), between the timeline and the composer: the pending
 * one to approve, edit or reject, and then, once, how the one being looked at ended (sent by a
 * colleague, replaced because the customer wrote again, and so on).
 */
export function AiDraftCard({ detail }: { detail: InboxDetail }) {
  const [watched, setWatched] = useState<string | null>(null);
  // Asked for only when the conversation says a draft is ready, or one shown here just ended.
  const drafts = useAiDrafts(detail.id, detail.aiDraftReady || watched !== null);
  const pending = drafts.data?.pending ?? null;
  const latest = drafts.data?.latest ?? null;
  useEffect(() => {
    if (pending) setWatched(pending.id);
  }, [pending]);
  if (pending) return <PendingDraft key={pending.id} detail={detail} draft={pending} />;
  if (latest && latest.id === watched) {
    return <EndedDraft draft={latest} onDismiss={() => setWatched(null)} />;
  }
  return null;
}
