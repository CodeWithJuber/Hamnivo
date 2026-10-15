import { Button } from '@hamnivo/ui/components/button';
import { Input } from '@hamnivo/ui/components/input';
import { Kbd } from '@hamnivo/ui/components/kbd';
import { LaneSurface } from '@hamnivo/ui/components/lane';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { Popover, PopoverContent, PopoverTrigger } from '@hamnivo/ui/components/popover';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { DeliveryStatus } from '@hamnivo/ui/components/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@hamnivo/ui/components/tabs';
import { Textarea } from '@hamnivo/ui/components/textarea';
import { cn } from '@hamnivo/ui/lib/utils';
import { type UseQueryResult, useQueryClient } from '@tanstack/react-query';
import {
  BookmarkIcon,
  ClockIcon,
  CopyIcon,
  FileTextIcon,
  GlobeIcon,
  LockIcon,
  type LucideIcon,
  MailIcon,
  MessageSquareIcon,
  SendIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError } from '../../components/States';
import { api, isApiError } from '../../lib/api';
import { type ReplyWindow, replyWindow } from '../../lib/channels';
import {
  type CopilotSuggestion,
  type DraftLane,
  type DraftsView,
  discardOutgoing,
  type InboxDetail,
  inboxKeys,
  localDraft,
  newClientId,
  type OutgoingMessage,
  type SavedReply,
  type SendInput,
  saveDraft,
  sendMessage,
  sendPresence,
  type TemplateSend,
  useOnline,
  useSavedReplies,
} from '../../lib/inbox';
import { withReauth } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import { ownership } from './ConversationPane';
import { useMyStaffId } from './parts';
import { SourceList } from './SourceList';
import { TemplateDialog } from './TemplateDialog';

type SaveState = 'idle' | 'saving' | 'saved' | 'local' | 'conflict';

/**
 * One lane's text, saved to the server as a personal draft a moment after typing stops, and kept
 * in this browser too so nothing is lost offline. A save from an older revision (another tab) is
 * refused by the server and shown as a choice, never overwritten silently.
 */
function useLaneDraft(conversationId: string, lane: DraftLane, drafts: UseQueryResult<DraftsView>) {
  const { tenantId } = useTenant();
  const local = useMemo(
    () => localDraft(tenantId, conversationId, lane),
    [tenantId, conversationId, lane],
  );
  const [text, setTextState] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const [conflict, setConflict] = useState<{ text: string; revision: number } | null>(null);
  const revision = useRef<number | undefined>(undefined);
  const saved = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ready = useRef(false);
  const latest = useRef('');

  const save = useCallback(async () => {
    const value = latest.current;
    if (value === saved.current) return;
    setState('saving');
    try {
      const result = await saveDraft(tenantId, conversationId, lane, value, revision.current);
      revision.current = result ? result.revision : undefined;
      saved.current = value;
      if (latest.current === value) local.write('');
      setState(value ? 'saved' : 'idle');
    } catch (error) {
      if (isApiError(error, 'VERSION_CONFLICT')) {
        const fresh = await drafts.refetch();
        const server = fresh.data?.drafts.find((d) => d.lane === lane);
        setConflict({ text: server?.text ?? '', revision: server?.revision ?? 0 });
        setState('conflict');
      } else setState('local');
    }
  }, [tenantId, conversationId, lane, drafts, local]);

  // The first load decides what to show: this browser's unsaved copy if it is newer.
  useEffect(() => {
    if (ready.current || !drafts.data) return;
    ready.current = true;
    const server = drafts.data.drafts.find((d) => d.lane === lane);
    const copy = local.read();
    revision.current = server?.revision;
    saved.current = server?.text ?? '';
    const serverAt = server ? Date.parse(server.updatedAt) : 0;
    if (copy && copy.at > serverAt && copy.text !== saved.current) {
      latest.current = copy.text;
      setTextState(copy.text);
      setState('local');
      timer.current = setTimeout(() => void save(), 500);
    } else {
      latest.current = saved.current;
      setTextState(saved.current);
    }
  }, [drafts.data, lane, local, save]);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Back online: save what was typed meanwhile.
  const online = useOnline();
  useEffect(() => {
    if (!online || !ready.current || latest.current === saved.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 300);
  }, [online, save]);

  const setText = (value: string) => {
    latest.current = value;
    setTextState(value);
    local.write(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 800);
  };

  /** After a send: the server removed the draft; forget it here too. */
  const clear = () => {
    clearTimeout(timer.current);
    latest.current = '';
    saved.current = '';
    revision.current = undefined;
    local.write('');
    setTextState('');
    setState('idle');
  };

  const resolveConflict = (keep: 'mine' | 'theirs') => {
    if (!conflict) return;
    revision.current = conflict.revision || undefined;
    saved.current = conflict.text;
    setConflict(null);
    if (keep === 'theirs') {
      latest.current = conflict.text;
      setTextState(conflict.text);
      local.write('');
      setState('saved');
    } else void save();
  };

  return { text, setText, clear, state, conflict, resolveConflict, retry: save };
}

function SavedReplies({
  detail,
  onInsert,
}: {
  detail: InboxDetail;
  onInsert: (reply: SavedReply) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const replies = useSavedReplies(detail.id, q, open && detail.permissions.reply);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="saved-replies">
          <BookmarkIcon aria-hidden="true" />
          {t('inbox.saved.button')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-80 flex-col gap-2">
        <Input
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          aria-label={t('inbox.saved.search')}
          placeholder={t('inbox.saved.search')}
          dir={q ? 'auto' : undefined}
        />
        {replies.isPending ? (
          <p className="text-sm text-text-secondary">{t('app.loading')}</p>
        ) : replies.error ? (
          <ActionError error={replies.error} />
        ) : (replies.data?.items ?? []).length === 0 ? (
          <p className="text-sm text-text-secondary">{t('inbox.saved.none')}</p>
        ) : (
          <ul
            className="flex max-h-72 flex-col gap-1 overflow-y-auto"
            aria-label={t('inbox.saved.button')}
          >
            {(replies.data?.items ?? []).map((reply) => (
              <li key={reply.id}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-0.5 rounded-md p-2 text-start hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => {
                    onInsert(reply);
                    setOpen(false);
                  }}
                >
                  <span className="font-mono text-xs text-text-secondary">
                    <bdi dir="ltr">/{reply.shortCode}</bdi>
                  </span>
                  <span className="line-clamp-2 text-sm text-text">
                    <bdi dir="auto">{reply.preview}</bdi>
                  </span>
                  {reply.missingVariables.length > 0 ? (
                    <span className="text-xs text-warning">
                      {t('inbox.saved.missing', { names: reply.missingVariables.join(', ') })}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function SuggestionPanel({
  suggestion,
  onUse,
  onSend,
  onDismiss,
  sending,
  canSend,
}: {
  suggestion: CopilotSuggestion;
  onUse: () => void;
  onSend: () => void;
  onDismiss: () => void;
  sending: boolean;
  canSend: string | null;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  return (
    <section
      aria-labelledby="suggestion-title"
      className="flex flex-col gap-2 rounded-lg border border-info/30 bg-info-subtle p-3"
      data-testid="copilot-suggestion"
    >
      <div className="flex items-start gap-2">
        <SparklesIcon className="mt-0.5 size-4 text-info" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 id="suggestion-title" className="text-sm font-semibold text-text">
            {t('inbox.copilot.title')}
          </h3>
          <p className="text-xs text-text-secondary">
            {t('inbox.copilot.review', { name: suggestion.agentName })}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('inbox.copilot.dismiss')}
          onClick={onDismiss}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <p className="text-sm whitespace-pre-wrap text-text">
        <bdi dir="auto">{suggestion.text}</bdi>
      </p>
      <SourceList sources={suggestion.sources} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onUse} data-testid="copilot-use">
          {t('inbox.copilot.use')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(suggestion.text)
              .then(() => announce(t('app.copied')))
              .catch(() => undefined)
          }
        >
          <CopyIcon aria-hidden="true" />
          {t('inbox.copilot.copy')}
        </Button>
        <ReasonedAction reason={canSend}>
          <Button size="sm" busy={sending} onClick={onSend} data-testid="copilot-send">
            <SendIcon className="rtl:-scale-x-100" aria-hidden="true" />
            {t('inbox.copilot.sendAsMe')}
          </Button>
        </ReasonedAction>
      </div>
    </section>
  );
}

function OutgoingItem({
  item,
  onRetry,
  onDiscard,
  busy,
}: {
  item: OutgoingMessage;
  onRetry: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const reason =
    item.errorCode === 'OWNERSHIP_CHANGED'
      ? t('inbox.outgoing.ownership')
      : item.errorCode === 'AUTHORITY_UNAVAILABLE'
        ? t('inbox.outgoing.unavailable')
        : item.errorCode === 'CHANNEL_WINDOW_CLOSED'
          ? t('channels.reply.closed')
          : t('inbox.outgoing.other');
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger-subtle p-3"
      data-testid="failed-send"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {item.lane === 'internal' ? (
          <span className="inline-flex items-center gap-1 font-medium text-text">
            <LockIcon className="size-3.5" aria-hidden="true" />
            {t('inbox.lanes.internal')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-medium text-text">
            <GlobeIcon className="size-3.5" aria-hidden="true" />
            {t('inbox.lanes.public')}
          </span>
        )}
        <DeliveryStatus
          state={item.state === 'sending' ? 'sending' : 'failed'}
          label={
            item.state === 'sending' ? t('inbox.outgoing.sending') : t('inbox.outgoing.failed')
          }
        />
      </div>
      <p className="line-clamp-3 text-sm whitespace-pre-wrap text-text">
        <bdi dir="auto">{item.text}</bdi>
      </p>
      {item.state === 'failed' ? <p className="text-xs text-text">{reason}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          busy={busy}
          onClick={onRetry}
          data-testid="retry-send"
        >
          {t('inbox.outgoing.retry')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
          {t('inbox.outgoing.discard')}
        </Button>
      </div>
    </li>
  );
}

type ReplyChannel = 'email' | 'whatsapp' | 'telegram';
const REPLY_CHANNEL_ICONS: Record<ReplyChannel, LucideIcon> = {
  email: MailIcon,
  whatsapp: MessageSquareIcon,
  telegram: SendIcon,
};
const isReplyChannel = (channel: string): channel is ReplyChannel => channel in REPLY_CHANNEL_ICONS;

/**
 * WhatsApp's reply window (W24) as it stands now, read again every half minute while it is open,
 * so "N minutes" counts down and the composer closes when the window does.
 */
export function useReplyWindow(
  channel: InboxDetail['channel'],
  closesAt: string | null,
): ReplyWindow {
  const [now, setNow] = useState(() => Date.now());
  const watched = channel === 'whatsapp' && Boolean(closesAt);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new closing time restarts the clock
  useEffect(() => {
    if (!watched) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [watched, closesAt]);
  return watched ? replyWindow(closesAt, now) : { state: 'open' };
}

/**
 * Where a reply goes when it is not web chat (by email, on WhatsApp, on Telegram), and on WhatsApp
 * how long it can still be sent. Once the window has closed, a notice says why replies are off
 * and offers a template instead.
 */
function ReplyChannelLine({
  channel,
  state,
  closed,
  onTemplate,
}: {
  channel: InboxDetail['channel'];
  state: ReplyWindow;
  closed: boolean;
  onTemplate: () => void;
}) {
  const { t } = useTranslation();
  if (closed) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning-subtle p-2 text-sm text-text">
        <p
          id="composer-window-closed"
          className="flex min-w-0 flex-1 basis-60 items-start gap-2"
          data-testid="reply-window-closed"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>{t('channels.reply.closed')}</span>
        </p>
        <Button size="sm" variant="secondary" onClick={onTemplate} data-testid="template-open">
          <FileTextIcon aria-hidden="true" />
          {t('channels.templates.open')}
        </Button>
      </div>
    );
  }
  if (!isReplyChannel(channel)) return null;
  const Icon = REPLY_CHANNEL_ICONS[channel];
  return (
    <p
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary"
      data-testid="reply-channel"
    >
      <span className="inline-flex items-center gap-1">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {t(`channels.reply.${channel}`)}
      </span>
      {state.state === 'closing' ? (
        <span
          className="inline-flex items-center gap-1 font-medium text-text"
          data-testid="reply-window-left"
        >
          <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {t('channels.reply.minutesLeft', { count: state.minutes })}
        </span>
      ) : null}
    </p>
  );
}

/**
 * The composer (HNV-09-01, HNV-09-02): Reply and Internal note are separate lanes with separate
 * drafts, so switching never moves text between them. Ctrl+Enter (⌘+Enter) sends; Enter makes a
 * new line, and keys pressed while an input method is composing text are left alone.
 */
export function Composer({
  detail,
  drafts,
}: {
  detail: InboxDetail;
  drafts: UseQueryResult<DraftsView>;
}) {
  const { t } = useTranslation();
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const online = useOnline();
  const me = useMyStaffId();
  const { mine, byOther } = ownership(detail, me);
  const [lane, setLane] = useState<DraftLane>(
    detail.permissions.reply && !byOther ? 'public' : 'internal',
  );
  const reply = useLaneDraft(detail.id, 'public', drafts);
  const note = useLaneDraft(detail.id, 'internal', drafts);
  const [sending, setSending] = useState<DraftLane | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [suggestion, setSuggestion] = useState<CopilotSuggestion | null>(null);
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [templates, setTemplates] = useState(false);
  const typing = useRef<{ at: number; timer?: ReturnType<typeof setTimeout> }>({ at: 0 });
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.part(detail.id, 'messages')] }),
      client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.part(detail.id, 'drafts')] }),
      client.invalidateQueries({
        queryKey: [tenantId, ...inboxKeys.conversation(detail.id)],
        exact: true,
      }),
      client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.lists] }),
    ]);

  // WhatsApp takes free text for 24 hours after the customer last wrote. The gateway decides; a
  // refusal it sends (the window closed while this was open) closes the composer here too.
  const closesAt = detail.replyWindowClosesAt ?? null;
  const replyState = useReplyWindow(detail.channel, closesAt);
  // The window the gateway refused a reply in; a new one (the customer wrote) opens it again.
  const [refusedIn, setRefusedIn] = useState<{ closesAt: string | null } | null>(null);
  const refused = refusedIn !== null && refusedIn.closesAt === closesAt;
  const windowClosed = detail.channel === 'whatsapp' && (refused || replyState.state === 'closed');
  const closedByWindow = windowClosed && detail.permissions.reply && !byOther;

  const replyBlocked = !detail.permissions.reply
    ? t('inbox.composer.noReply')
    : byOther
      ? t('inbox.composer.ownedByOther', {
          name:
            detail.owner.kind === 'staff' ? detail.owner.displayName : t('inbox.owner.external'),
        })
      : windowClosed
        ? t('channels.reply.closed')
        : null;
  const noteBlocked = detail.permissions.note ? null : t('inbox.composer.noNote');
  // WhatsApp takes an approved template at any time, inside the 24 hours or after them (D14).
  const canTemplate = detail.channel === 'whatsapp' && detail.permissions.reply && !byOther;

  const markTyping = (current: DraftLane) => {
    const now = Date.now();
    if (now - typing.current.at > 4000) {
      typing.current.at = now;
      sendPresence(tenantId, detail.id, 'typing', current);
    }
    clearTimeout(typing.current.timer);
    typing.current.timer = setTimeout(() => {
      typing.current.at = 0;
      sendPresence(tenantId, detail.id, 'viewing');
    }, 6000);
  };
  useEffect(() => () => clearTimeout(typing.current.timer), []);

  const send = async (input: SendInput, after?: () => void) => {
    setSending(input.lane);
    setError(null);
    try {
      await withReauth(() => sendMessage(tenantId, detail.id, input));
      after?.();
      announce(
        input.lane === 'internal' ? t('inbox.composer.noteAdded') : t('inbox.composer.sent'),
      );
    } catch (caught) {
      if (isApiError(caught, 'CHANNEL_WINDOW_CLOSED')) {
        // Nothing was sent; the text stays in the draft. Say why instead of a generic error.
        setRefusedIn({ closesAt });
        announce(t('channels.reply.closed'), 'assertive');
      } else {
        setError(caught);
        announce(t('inbox.composer.notSent'), 'assertive');
      }
    } finally {
      setSending(null);
      await refresh();
    }
  };

  const submit = (current: DraftLane) => {
    const draft = current === 'public' ? reply : note;
    const text = draft.text.trim();
    if (!text || sending) return;
    if (current === 'public' && replyBlocked) return;
    if (current === 'internal' && noteBlocked) return;
    const input: SendInput = {
      clientMessageId: newClientId(),
      text,
      lane: current,
      expectedEpoch: detail.ownershipEpoch,
      ...(current === 'public' && suggestionId ? { suggestionId } : {}),
    };
    void send(input, () => {
      draft.clear();
      if (current === 'public') setSuggestionId(null);
    });
  };

  const onKeyDown = (current: DraftLane) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Never act on keys that finish a word in an input method (Japanese, Chinese, Korean…).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit(current);
    }
  };

  const insert = (text: string) => {
    const target = lane === 'public' ? replyRef.current : noteRef.current;
    const draft = lane === 'public' ? reply : note;
    const start = target?.selectionStart ?? draft.text.length;
    const end = target?.selectionEnd ?? draft.text.length;
    const next = `${draft.text.slice(0, start)}${text}${draft.text.slice(end)}`;
    draft.setText(next);
    requestAnimationFrame(() => {
      target?.focus();
      const at = start + text.length;
      target?.setSelectionRange(at, at);
    });
  };

  /** Sends a template from the dialog; the dialog shows what went wrong. */
  const sendTemplate = async (template: TemplateSend, clientMessageId: string) => {
    try {
      await withReauth(() =>
        sendMessage(tenantId, detail.id, {
          clientMessageId,
          text: '',
          lane: 'public',
          expectedEpoch: detail.ownershipEpoch,
          template,
        }),
      );
      announce(t('channels.templates.sent'));
    } finally {
      await refresh();
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const result = await withReauth(() =>
        api<CopilotSuggestion>(`/v1/inbox/conversations/${detail.id}/copilot`, {
          method: 'POST',
          tenant: tenantId,
          body: { clientRequestId: newClientId() },
        }),
      );
      setSuggestion(result);
      announce(t('inbox.copilot.ready'));
    } catch (caught) {
      setSuggestError(caught);
    } finally {
      setSuggesting(false);
    }
  };

  const outgoing = drafts.data?.outgoing ?? [];
  const retry = async (item: OutgoingMessage) => {
    setRetrying(item.clientMessageId);
    // The same message id: if the first try reached Chatwoot, nothing is sent twice.
    await send({
      clientMessageId: item.clientMessageId,
      text: item.text,
      lane: item.lane,
      expectedEpoch: detail.ownershipEpoch,
    });
    setRetrying(null);
  };
  const discard = async (item: OutgoingMessage) => {
    setRetrying(item.clientMessageId);
    try {
      await withReauth(() => discardOutgoing(tenantId, detail.id, item.clientMessageId));
      announce(t('inbox.outgoing.discarded'));
    } catch (caught) {
      setError(caught);
    } finally {
      setRetrying(null);
      await refresh();
    }
  };

  const hint =
    lane === 'public' && !replyBlocked
      ? detail.ownerMode === 'AI_ACTIVE'
        ? t('inbox.composer.takesOverAi')
        : !mine
          ? t('inbox.composer.takesOver')
          : null
      : null;
  const draft = lane === 'public' ? reply : note;
  const saveText =
    draft.state === 'saving'
      ? t('inbox.composer.saving')
      : draft.state === 'saved'
        ? t('inbox.composer.saved')
        : draft.state === 'local'
          ? online
            ? t('inbox.composer.savedHere')
            : t('inbox.composer.offlineSaved')
          : '';
  const othersTyping = detail.presence.filter((p) => p.state === 'typing' && p.lane === lane);

  const editor = (current: DraftLane) => {
    const value = current === 'public' ? reply : note;
    const blocked = current === 'public' ? replyBlocked : noteBlocked;
    const id = `composer-${current}`;
    // The notice above says it already; the field points to it.
    const byWindow = current === 'public' && closedByWindow;
    return (
      <LaneSurface
        lane={current === 'public' ? 'public' : 'internal'}
        className="flex flex-col gap-2 p-2"
      >
        <label htmlFor={id} className="sr-only">
          {current === 'public'
            ? t('inbox.composer.replyLabel', { name: detail.customer.displayName })
            : t('inbox.composer.noteLabel')}
        </label>
        <Textarea
          id={id}
          ref={current === 'public' ? replyRef : noteRef}
          value={value.text}
          onChange={(event) => {
            value.setText(event.target.value);
            if (event.target.value) markTyping(current);
          }}
          onKeyDown={onKeyDown(current)}
          placeholder={
            current === 'public'
              ? t('inbox.composer.replyPlaceholder', { name: detail.customer.displayName })
              : t('inbox.composer.notePlaceholder')
          }
          aria-describedby={byWindow ? `${id}-hint composer-window-closed` : `${id}-hint`}
          readOnly={Boolean(blocked)}
          dir={value.text ? 'auto' : undefined}
          rows={3}
          maxLength={10_000}
          className="min-h-20 resize-y border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          data-testid={`composer-${current}`}
        />
        {value.conflict ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-md bg-warning-subtle p-2 text-xs text-text"
          >
            <span className="min-w-0 flex-1">{t('inbox.composer.conflict')}</span>
            <Button size="sm" variant="secondary" onClick={() => value.resolveConflict('mine')}>
              {t('inbox.composer.keepMine')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => value.resolveConflict('theirs')}>
              {t('inbox.composer.useTheirs')}
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {current === 'public' && detail.permissions.reply && !windowClosed ? (
            <>
              <SavedReplies
                detail={detail}
                onInsert={(item) => {
                  insert(item.preview);
                  if (item.missingVariables.length > 0) {
                    announce(t('inbox.saved.missing', { names: item.missingVariables.join(', ') }));
                  }
                }}
              />
              {canTemplate ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTemplates(true)}
                  data-testid="template-button"
                >
                  <FileTextIcon aria-hidden="true" />
                  {t('channels.templates.button')}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                busy={suggesting}
                onClick={() => void suggest()}
                data-testid="copilot"
              >
                <SparklesIcon aria-hidden="true" />
                {t('inbox.copilot.button')}
              </Button>
            </>
          ) : null}
          <span
            id={`${id}-hint`}
            className="ms-auto flex flex-wrap items-center gap-2 text-xs text-text-secondary"
          >
            {byWindow ? null : blocked ? (
              <span className="text-text">{blocked}</span>
            ) : (
              <>
                <span aria-live="polite">{current === lane ? saveText : ''}</span>
                <span className="hidden sm:inline">
                  <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> {t('inbox.composer.toSend')}
                </span>
              </>
            )}
          </span>
          <Button
            size="sm"
            busy={sending === current}
            disabled={Boolean(blocked) || !value.text.trim()}
            onClick={() => submit(current)}
            data-testid={current === 'public' ? 'send-reply' : 'add-note'}
          >
            {current === 'public' ? (
              <SendIcon className="rtl:-scale-x-100" aria-hidden="true" />
            ) : (
              <LockIcon aria-hidden="true" />
            )}
            {current === 'public' ? t('inbox.composer.send') : t('inbox.composer.addNote')}
          </Button>
        </div>
      </LaneSurface>
    );
  };

  return (
    <div
      className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-bg p-3 lg:static"
      data-testid="composer"
    >
      {outgoing.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={t('inbox.outgoing.label')}>
          {outgoing.map((item) => (
            <OutgoingItem
              key={item.clientMessageId}
              item={item}
              busy={retrying === item.clientMessageId}
              onRetry={() => void retry(item)}
              onDiscard={() => void discard(item)}
            />
          ))}
        </ul>
      ) : null}
      {error ? (
        isApiError(error, 'OWNERSHIP_CHANGED') ? (
          <p
            role="alert"
            className="rounded-md bg-warning-subtle p-2 text-sm text-text"
            data-testid="stale-send"
          >
            {t('inbox.composer.staleSend')}
          </p>
        ) : (
          <ActionError error={error} />
        )
      ) : null}
      {suggestion && lane === 'public' ? (
        <SuggestionPanel
          suggestion={suggestion}
          sending={sending === 'public'}
          canSend={replyBlocked}
          onUse={() => {
            reply.setText(suggestion.text);
            setSuggestionId(suggestion.id);
            setSuggestion(null);
            requestAnimationFrame(() => replyRef.current?.focus());
          }}
          onSend={() =>
            void send(
              {
                clientMessageId: newClientId(),
                text: suggestion.text,
                lane: 'public',
                expectedEpoch: detail.ownershipEpoch,
                suggestionId: suggestion.id,
              },
              () => setSuggestion(null),
            )
          }
          onDismiss={() => setSuggestion(null)}
        />
      ) : null}
      {suggestError && lane === 'public' ? (
        isApiError(suggestError, 'FEATURE_DISABLED') ? (
          <p role="alert" className="text-sm text-text">
            {t('inbox.copilot.off')}
          </p>
        ) : (
          <ActionError error={suggestError} />
        )
      ) : null}
      {othersTyping.length > 0 ? (
        <p className="text-xs font-medium text-warning" data-testid="collision">
          {t(lane === 'internal' ? 'inbox.presence.alsoNote' : 'inbox.presence.alsoReply', {
            name: othersTyping.map((p) => p.displayName).join(', '),
          })}
        </p>
      ) : null}
      <Tabs value={lane} onValueChange={(value) => setLane(value as DraftLane)} className="gap-2">
        <TabsList variant="line" aria-label={t('inbox.composer.lanes')}>
          <TabsTrigger
            value="public"
            data-testid="lane-public"
            className="text-text-secondary data-[state=active]:text-text"
          >
            <GlobeIcon aria-hidden="true" />
            {t('inbox.lanes.public')}
            {reply.text && lane !== 'public' ? (
              <span className="text-xs font-normal text-text-secondary">
                {t('inbox.composer.hasDraft')}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger
            value="internal"
            data-testid="lane-internal"
            className="text-text-secondary data-[state=active]:text-text"
          >
            <LockIcon aria-hidden="true" />
            {t('inbox.lanes.internal')}
            {note.text && lane !== 'internal' ? (
              <span className="text-xs font-normal text-text-secondary">
                {t('inbox.composer.hasDraft')}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>
        <p className={cn('text-xs', lane === 'internal' ? 'text-text' : 'text-text-secondary')}>
          {lane === 'internal'
            ? t('inbox.lanes.internalDescription')
            : t('inbox.lanes.publicDescription')}
          {hint ? ` ${hint}` : ''}
        </p>
        {lane === 'public' ? (
          <ReplyChannelLine
            channel={detail.channel}
            state={replyState}
            closed={closedByWindow}
            onTemplate={() => setTemplates(true)}
          />
        ) : null}
        <TabsContent value="public">{editor('public')}</TabsContent>
        <TabsContent value="internal">{editor('internal')}</TabsContent>
      </Tabs>
      {canTemplate ? (
        <TemplateDialog
          open={templates}
          onOpenChange={setTemplates}
          detail={detail}
          onSend={sendTemplate}
        />
      ) : null}
    </div>
  );
}
