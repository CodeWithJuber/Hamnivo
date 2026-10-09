import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useThreadViewport,
} from '@assistant-ui/react';
import {
  HamnivoApiError,
  type HamnivoClient,
  type OutgoingAttachment,
  type OutgoingMessage,
  type StartConversationInput,
} from '@hamnivo/client';
import type {
  DeliveryState,
  FormAnswers,
  Message,
  MessagePart,
  OfflineMessageResponse,
  ReactionEmoji,
  ReplyLanguage,
  WidgetLanguageState,
  WidgetLayoutMode,
  WidgetSession,
} from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ParticipantBadge, type ParticipantKind } from '@hamnivo/ui/components/participant-badge';
import { PaperclipIcon, SendHorizontalIcon, XIcon } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { offlineFormApplies } from '../availability.js';
import { CommerceCard, type Part } from '../commerce/Cards.js';
import { ShopBar } from '../commerce/ShopBar.js';
import type { Commerce } from '../commerce/useCommerce.js';
import { type Draft, draftText } from '../drafts.js';
import {
  consentNeeded,
  type FieldValues,
  firstMessageOf,
  isConsentRequired,
  labelOf,
  prechatNeeded,
} from '../forms.js';
import { LANGUAGE_NAMES, LOCALES, type Locale, REPLY_LANGUAGE_NAMES } from '../i18n.js';
import { renderMarkdown } from '../markdown.js';
import { type ChatState, chatAvailable } from '../useChat.js';
import type { DisplayControls } from '../useDisplay.js';
import type { MemoryControls } from '../useMemory.js';
import { useTypingReports } from '../useTyping.js';
import { BidiText, directionOf } from './BidiText.js';
import { BrandMark } from './BrandMark.js';
import { ContactForm } from './ContactForm.js';
import { Conversations } from './Conversations.js';
import { Csat } from './Csat.js';
import { Home } from './Home.js';
import { MemoryConsent } from './MemoryConsent.js';
import { MemoryPanel, useSlotLabel } from './MemoryPanel.js';
import { DeleteMessage, EMOJI_NAMES, Reactions } from './MessageActions.js';
import { Contact, Files, fileSize, Place, Unknown } from './Parts.js';
import { PrivacyLink } from './PrivacyLink.js';
import { Reopen } from './Reopen.js';
import { Settings } from './Settings.js';
import { StaffTypingLine } from './StaffTyping.js';
import { StartGate } from './StartGate.js';
import { StatusLine } from './StatusLine.js';
import { TicketLine } from './TicketLine.js';
import { VisitorNotice } from './VisitorNotice.js';

interface Source {
  id: string;
  title: string;
  url: string | null;
  excerpt: string | null;
}

type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;

interface Custom {
  kind: ParticipantKind;
  name: string;
  role: string;
  /** `provisional`: an AI reply still being written or checked, not a message yet. */
  state: 'accepted' | 'provisional' | OutgoingMessage['state'];
  clientMessageId?: string;
  /** Knowledge an AI answer cites, numbered as in its text (G06). */
  sources?: Source[];
  /** A card (quote, receipt…) from Hamnivo's records, rendered instead of text. */
  card?: Part;
  /** Memories an AI answer used (G19): shown as memories, never as something said now. */
  memories?: string[];
  /** The confirmed message's id and time (for deleting and reacting). */
  messageId?: string;
  createdAt?: string;
  delivery?: DeliveryState | null;
  /** Files the message carries (W09), and those of a message still being sent. */
  files?: AttachmentPart[];
  pendingFiles?: OutgoingAttachment[];
  /** Places, contacts and parts this widget does not know (W24). */
  extras?: MessagePart[];
  deleted?: boolean;
  reaction?: { emoji: ReactionEmoji };
  /** The first reply the visitor had not seen when the conversation opened (W05). */
  firstUnread?: boolean;
  /** The visitor's newest confirmed message, which shows "Sent" or "Read" (W06). */
  lastMine?: boolean;
  /** The API's code for a failed send, to explain it. */
  errorCode?: string;
}

const textOf = (m: Message) =>
  m.parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'card' ? p.fallbackText : ''))
    .join('\n')
    .trim();

/** Words of a message for announcements, naming what was shared. */
const spokenOf = (m: Message, file: (name: string) => string) =>
  [textOf(m), ...m.parts.flatMap((p) => (p.type === 'attachment' ? [file(p.name)] : []))]
    .filter(Boolean)
    .join(' ');

const cardOf = (m: Message): Part | undefined => m.parts.find((p): p is Part => p.type === 'card');
const memoriesOf = (m: Message): string[] =>
  m.parts.flatMap((p) => (p.type === 'memory' ? [p.key] : []));

const sourcesOf = (m: Message): Source[] =>
  m.parts.flatMap((p) =>
    p.type === 'source' ? [{ id: p.sourceId, title: p.title, url: p.url, excerpt: p.excerpt }] : [],
  );
const filesOf = (m: Message): AttachmentPart[] =>
  m.parts.filter((p): p is AttachmentPart => p.type === 'attachment');
const extrasOf = (m: Message): MessagePart[] =>
  m.parts.filter((p) => p.type === 'location' || p.type === 'contact' || p.type === 'unknown');
const deletedOf = (m: Message) =>
  m.parts.some((p) => p.type === 'notice' && p.notice === 'message_deleted');
const reactionOf = (m: Message) => {
  const part = m.parts.find((p) => p.type === 'reaction');
  return part?.type === 'reaction' ? { emoji: part.emoji } : undefined;
};

function toThread(
  messages: Message[],
  pending: readonly OutgoingMessage[],
  you: string,
  firstUnreadId: string | null,
  drafts: readonly Draft[] = [],
): ThreadMessageLike[] {
  const lastMine = messages.findLast(
    (m) => m.sender.kind === 'customer' && !deletedOf(m) && !reactionOf(m),
  )?.id;
  const confirmed = messages.map((m): ThreadMessageLike => {
    const kind: ParticipantKind =
      m.sender.kind === 'ai_agent' ? 'ai_primary' : (m.sender.kind as ParticipantKind);
    const deleted = deletedOf(m);
    return {
      id: m.id,
      role:
        m.sender.kind === 'customer' ? 'user' : m.sender.kind === 'system' ? 'system' : 'assistant',
      content: [{ type: 'text', text: deleted ? '' : textOf(m) }],
      createdAt: new Date(m.createdAt),
      metadata: {
        custom: {
          kind,
          name: m.sender.kind === 'customer' ? you : m.sender.displayName,
          role: m.sender.roleLabel ?? '',
          state: 'accepted',
          sources: sourcesOf(m),
          ...(cardOf(m) ? { card: cardOf(m) } : {}),
          memories: memoriesOf(m),
          messageId: m.id,
          createdAt: m.createdAt,
          delivery: m.delivery,
          files: deleted ? [] : filesOf(m),
          extras: deleted ? [] : extrasOf(m),
          deleted,
          ...(reactionOf(m) ? { reaction: reactionOf(m) } : {}),
          firstUnread: m.id === firstUnreadId,
          lastMine: m.id === lastMine,
        } satisfies Custom,
      },
    };
  });
  const unsent = pending.map(
    (p): ThreadMessageLike => ({
      id: `pending-${p.clientMessageId}`,
      role: 'user',
      content: [{ type: 'text', text: p.text }],
      createdAt: new Date(p.createdAt),
      metadata: {
        custom: {
          kind: 'customer',
          name: you,
          role: '',
          state: p.state,
          clientMessageId: p.clientMessageId,
          pendingFiles: p.attachments ?? [],
          ...(p.errorCode ? { errorCode: p.errorCode } : {}),
        } satisfies Custom,
      },
    }),
  );
  const provisional = drafts.map(
    (draft): ThreadMessageLike => ({
      id: `draft-${draft.draftId}`,
      role: 'assistant',
      content: [{ type: 'text', text: draftText(draft) }],
      metadata: {
        custom: { kind: 'ai_primary', name: '', role: '', state: 'provisional' } satisfies Custom,
      },
    }),
  );
  return [...confirmed, ...unsent, ...provisional];
}

interface BubbleContext {
  client: HamnivoClient;
  conversationId: string | null;
  commerce: Commerce;
  locale: Locale;
  offline: boolean;
  /** How long after sending a message can be deleted; 0 when it can't (W23). */
  deleteWindowMs: number;
  /** Chat isn't available to this visitor (H20): messages can be read, not answered or reacted to. */
  readOnly: boolean;
  onRetry: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onHelp: (() => void) | undefined;
  onOpenMemory: () => void;
  onDelete: (messageId: string) => Promise<void>;
  onReact: (messageId: string, emoji: ReactionEmoji) => Promise<void>;
}

/** Why a message was not sent, in words a customer can act on (HNV-06-03). */
function causeOf(
  code: string | undefined,
): 'files' | 'invalid' | 'closed' | 'unavailable' | 'other' {
  if (code === 'CHAT_UNAVAILABLE') return 'unavailable';
  if (code === 'UPLOAD_REJECTED' || code === 'FEATURE_DISABLED') return 'files';
  if (code === 'VALIDATION_FAILED' || code === 'IDEMPOTENCY_CONFLICT') return 'invalid';
  if (code === 'NOT_FOUND' || code === 'CONVERSATION_CLOSED') return 'closed';
  return 'other';
}

/** "Waiting", "Sending…", "Not sent" with what to do, or "Sent" and "Read" (W06). */
function Delivery({ custom, ctx }: { custom: Partial<Custom>; ctx: BubbleContext }) {
  const { t } = useTranslation();
  const id = custom.clientMessageId;
  if (custom.state === 'failed' && id) {
    const cause = causeOf(custom.errorCode);
    // While chat isn't available, sending again or editing can't help; the message can go.
    const stuck = cause === 'unavailable' || ctx.readOnly;
    return (
      <div className="flex max-w-[85%] flex-col items-end gap-1 text-xs" role="alert">
        <span className="text-danger">
          {t('surface.delivery.failed')} {t(`surface.delivery.causes.${cause}`)}
        </span>
        <span className="flex flex-wrap justify-end gap-3">
          {stuck ? null : (
            <>
              <Button variant="link" className="h-auto text-xs" onClick={() => ctx.onRetry(id)}>
                {t('surface.delivery.retry')}
              </Button>
              <Button variant="link" className="h-auto text-xs" onClick={() => ctx.onEdit(id)}>
                {t('surface.delivery.edit')}
              </Button>
            </>
          )}
          <Button variant="link" className="h-auto text-xs" onClick={() => ctx.onRemove(id)}>
            {t('surface.delivery.remove')}
          </Button>
        </span>
      </div>
    );
  }
  if (custom.state === 'queued' || custom.state === 'sending') {
    const waiting = custom.state === 'queued' && ctx.offline;
    return (
      <p
        className="flex flex-wrap items-center justify-end gap-3 text-xs text-text-muted"
        data-testid="delivery"
      >
        <span>{waiting ? t('surface.delivery.queued') : t('surface.delivery.sending')}</span>
        {waiting && id ? (
          <>
            <Button variant="link" className="h-auto text-xs" onClick={() => ctx.onEdit(id)}>
              {t('surface.delivery.edit')}
            </Button>
            <Button variant="link" className="h-auto text-xs" onClick={() => ctx.onRemove(id)}>
              {t('surface.delivery.remove')}
            </Button>
          </>
        ) : null}
      </p>
    );
  }
  if (custom.lastMine) {
    return (
      <p className="text-xs text-text-muted" data-testid="delivery">
        {custom.delivery === 'read' ? t('surface.delivery.read') : t('surface.delivery.sent')}
      </p>
    );
  }
  return null;
}

function Bubble({ message, ctx }: { message: ThreadMessageLike; ctx: BubbleContext }) {
  const { t } = useTranslation();
  const slotLabel = useSlotLabel();
  const custom = (message.metadata?.custom ?? {}) as unknown as Partial<Custom>;
  const divider = custom.firstUnread ? (
    <li
      className="flex items-center gap-2 text-xs font-medium text-info"
      data-testid="unread-divider"
    >
      <span className="h-px flex-1 bg-info/40" aria-hidden="true" />
      {t('surface.history.newMessages')}
      <span className="h-px flex-1 bg-info/40" aria-hidden="true" />
    </li>
  ) : null;
  if (custom.card) {
    return (
      <>
        {divider}
        <li className="flex flex-col items-start gap-1" data-sender="system">
          <CommerceCard
            part={custom.card}
            commerce={ctx.commerce}
            locale={ctx.locale}
            onHelp={ctx.onHelp}
          />
        </li>
      </>
    );
  }
  // While the AI is expected to answer, assistant-ui adds an optimistic placeholder message.
  if (!custom.kind) {
    return message.role === 'assistant' ? (
      <li className="text-sm text-text-muted" data-testid="ai-writing">
        {t('typing')}
      </li>
    ) : null;
  }
  const mine = message.role === 'user';
  if (custom.reaction) {
    return (
      <li
        className={`flex text-xs text-text-muted ${mine ? 'justify-end' : 'justify-start'}`}
        data-sender={custom.kind}
        data-testid="reaction"
      >
        {t('surface.actions.reacted', {
          emoji: t(`surface.actions.emoji.${EMOJI_NAMES[custom.reaction.emoji]}`),
        })}{' '}
        <span aria-hidden="true">{custom.reaction.emoji}</span>
      </li>
    );
  }
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.map((p) => ('text' in p ? p.text : '')).join('');
  // A draft is shown as an answer being checked, plain text, never as a final message.
  if (custom.state === 'provisional') {
    return (
      <li
        className="flex flex-col items-start gap-1"
        data-sender={custom.kind}
        data-state="provisional"
        data-testid="draft-reply"
        aria-busy="true"
      >
        <p className="text-xs text-text-muted">{t('draftChecking')}</p>
        <div
          dir={directionOf(text)}
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border border-dashed border-border px-3 py-2 text-[15px] leading-relaxed text-text-muted"
        >
          <BidiText text={text} />
        </div>
      </li>
    );
  }
  const messageId = custom.messageId;
  const canDelete =
    mine &&
    !ctx.readOnly &&
    custom.state === 'accepted' &&
    !custom.deleted &&
    messageId !== undefined &&
    ctx.deleteWindowMs > 0 &&
    Date.now() - Date.parse(custom.createdAt ?? '') < ctx.deleteWindowMs;
  const canReact =
    !mine &&
    !ctx.readOnly &&
    !custom.deleted &&
    messageId !== undefined &&
    (custom.kind === 'ai_primary' || custom.kind === 'human_agent');
  return (
    <>
      {divider}
      <li
        className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}
        data-sender={custom.kind}
        data-state={custom.state}
        data-delivery={custom.delivery ?? undefined}
      >
        {!mine && custom.kind !== 'system' ? (
          <ParticipantBadge
            kind={custom.kind}
            name={custom.name ?? ''}
            roleLabel={custom.role ?? ''}
          />
        ) : null}
        {custom.deleted ? (
          <p
            className="max-w-[85%] rounded-2xl border border-dashed border-border px-3 py-2 text-sm italic text-text-muted"
            data-testid="message-deleted"
          >
            {t('surface.parts.deleted')}
          </p>
        ) : !text ? null : mine || custom.kind === 'system' ? (
          <div
            dir={directionOf(text)}
            data-testid="message-text"
            className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[0.9375rem] leading-relaxed ${
              mine ? 'bg-primary text-primary-foreground' : 'bg-transparent text-text-muted text-sm'
            }`}
          >
            <BidiText text={text} />
          </div>
        ) : (
          <div
            dir={directionOf(text)}
            data-testid="message-text"
            className="hv-markdown max-w-[85%] break-words rounded-2xl border border-border bg-surface px-3 py-2 text-[0.9375rem] leading-relaxed text-text"
            // Sanitized by renderMarkdown: a short allow-list of tags and http(s) links only.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        )}
        {custom.files?.length && ctx.conversationId ? (
          <Files
            client={ctx.client}
            conversationId={ctx.conversationId}
            parts={custom.files}
            locale={ctx.locale}
          />
        ) : null}
        {custom.pendingFiles?.length ? (
          <ul className="flex max-w-[85%] flex-col items-end gap-1 text-xs text-text-muted">
            {custom.pendingFiles.map((file) => (
              <li key={file.uploadId} className="flex items-center gap-1">
                <PaperclipIcon className="size-3.5" aria-hidden="true" />
                <BidiText text={file.name} /> · {fileSize(file.sizeBytes, ctx.locale)}
              </li>
            ))}
          </ul>
        ) : null}
        {custom.extras?.map((part) =>
          part.type === 'location' ? (
            <Place key={`place-${part.latitude}-${part.longitude}`} part={part} />
          ) : part.type === 'contact' ? (
            <Contact key={`contact-${part.name}-${part.phone ?? ''}`} part={part} />
          ) : part.type === 'unknown' ? (
            <Unknown key={`unknown-${part.originalType}-${part.fallbackText ?? ''}`} part={part} />
          ) : null,
        )}
        {custom.sources?.length ? (
          <div className="max-w-[85%] text-xs text-text-muted" data-testid="sources">
            <p className="font-medium">{t('sources')}</p>
            <ol className="list-decimal ps-5">
              {custom.sources.map((source) => (
                <li key={source.id} dir="auto">
                  {source.url ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-link underline underline-offset-2"
                    >
                      {source.title}
                    </a>
                  ) : (
                    source.title
                  )}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {custom.memories?.length ? (
          <p className="max-w-[85%] text-xs text-text-muted" data-testid="memory-note">
            {t('memory.used', {
              labels: [...new Set(custom.memories)].map(slotLabel).join(', '),
            })}{' '}
            <Button variant="link" className="h-auto text-xs" onClick={ctx.onOpenMemory}>
              {t('memory.see')}
            </Button>
          </p>
        ) : null}
        {mine ? <Delivery custom={custom} ctx={ctx} /> : null}
        {canDelete && messageId ? <DeleteMessage onDelete={() => ctx.onDelete(messageId)} /> : null}
        {canReact && messageId ? (
          <Reactions onReact={(emoji) => ctx.onReact(messageId, emoji)} />
        ) : null}
      </li>
    </>
  );
}

/** Language tags for the reply language buttons, so screen readers use the right voice. */
const LANG_TAGS: Record<ReplyLanguage, string> = {
  en: 'en',
  ar: 'ar',
  hi: 'hi',
  ur: 'ur',
  'hi-Latn': 'hi-Latn',
  'ur-Latn': 'ur-Latn',
};

/**
 * Asks once which language replies should use when the customer's words fit two (HNV-07-04):
 * Hinglish and Roman Urdu read the same. The suggestion comes first; the message stays as sent.
 */
function LanguageQuestion(props: {
  state: WidgetLanguageState | null;
  onChoose: (language: ReplyLanguage) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const confirm = props.state?.confirm;
  if (!confirm) return null;
  const run = async (work: () => Promise<void>, done?: string) => {
    setBusy(true);
    try {
      await work();
      if (done) announce(done);
    } catch {
      // The question stays; the customer can try again.
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby="hv-language-question"
      className="mb-2 rounded-xl border border-border bg-surface-sunken px-3 py-2"
      data-testid="language-question"
    >
      <h2 id="hv-language-question" className="mb-2 text-sm font-medium text-text">
        {t('languageQuestion')}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {[confirm.suggested, ...confirm.alternatives].map((language) => (
          <Button
            key={language}
            size="sm"
            variant={language === confirm.suggested ? 'default' : 'outline'}
            lang={LANG_TAGS[language]}
            dir="auto"
            disabled={busy}
            onClick={() =>
              void run(
                () => props.onChoose(language),
                t('languageChosen', { language: REPLY_LANGUAGE_NAMES[language] }),
              )
            }
          >
            {REPLY_LANGUAGE_NAMES[language]}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(props.onDismiss)}>
          {t('languageNotNow')}
        </Button>
      </div>
    </section>
  );
}

/** A file being attached: checked by the gateway, then sent with the next message (W09). */
export interface Chip {
  id: string;
  name: string;
  size: number;
  state: 'uploading' | 'ready' | 'refused';
  file?: OutgoingAttachment;
  reason?: string;
}

/** "Send" with an arrow; on very narrow screens (or large text) only the arrow shows. */
function SendLabel({ text }: { text: string }) {
  return (
    <>
      <SendHorizontalIcon className="size-4 rtl:-scale-x-100" aria-hidden="true" />
      <span className="max-[15rem]:sr-only">{text}</span>
    </>
  );
}

/**
 * The message box (U08). Enter sends and Shift+Enter starts a new line, but an Enter that
 * confirms an input method composition (Hindi, Urdu, Arabic or Chinese keyboards) never sends:
 * browsers flag it with isComposing, Safari only with key code 229 after the composition ends.
 * The box follows the direction of what is typed, so Urdu typed in the English interface reads
 * right to left. Files go with the words (W09); what is typed is kept as a draft (W07).
 */
function Composer(props: {
  label: string;
  send: string;
  draftScope: string;
  /** The conversation the words go to; null before there is one (nothing is reported then). */
  conversationId: string | null;
  client: HamnivoClient;
  chips: readonly Chip[];
  attach: { allowed: boolean; accept: string; maxFiles: number; maxMb: number };
  onFiles: (files: File[]) => void;
  onRemoveChip: (id: string) => void;
  onSendFiles: () => void;
  locale: string;
}) {
  const { t } = useTranslation();
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const composing = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const uploading = props.chips.some((c) => c.state === 'uploading');
  const ready = props.chips.some((c) => c.state === 'ready');
  const { drafts } = props.client;
  const scope = props.draftScope;
  const { conversationId, client } = props;
  // Staff see "typing…" while the visitor writes.
  useTypingReports(
    conversationId ? (typing) => client.reportTyping(conversationId, typing) : null,
    text,
  );

  // The draft comes back after a reload; typing keeps it for this person and conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the scope changes
  useEffect(() => {
    const draft = drafts.get(scope);
    if (draft && !aui.composer().getState().text) aui.composer().setText(draft);
  }, [scope]);
  useEffect(() => {
    const timer = setTimeout(() => drafts.set(scope, text), 300);
    return () => clearTimeout(timer);
  }, [drafts, scope, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  const onSubmit = (event: FormEvent) => {
    if (uploading) {
      event.preventDefault();
      return;
    }
    // Files alone: the composer only sends words, so they go from here.
    if (!text.trim() && ready) {
      event.preventDefault();
      props.onSendFiles();
    }
  };
  return (
    <ComposerPrimitive.Root className="flex flex-col gap-2" onSubmit={onSubmit}>
      {props.chips.length ? (
        <ul
          className="flex flex-wrap gap-2"
          aria-label={t('surface.files.attach')}
          data-testid="file-chips"
        >
          {props.chips.map((chip) => (
            <li
              key={chip.id}
              className={`flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-xs ${
                chip.state === 'refused'
                  ? 'border-danger/40 text-danger'
                  : 'border-border text-text'
              }`}
              data-state={chip.state}
            >
              <PaperclipIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-all">
                <BidiText text={chip.name} />
              </span>
              <span className="text-text-muted">· {fileSize(chip.size, props.locale)}</span>
              <span className="text-text-muted">
                ·{' '}
                {chip.state === 'uploading'
                  ? t('surface.files.uploading')
                  : chip.state === 'ready'
                    ? t('surface.files.ready')
                    : (chip.reason ?? t('surface.files.refused'))}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-8"
                aria-label={t('surface.files.remove', { name: chip.name })}
                onClick={() => props.onRemoveChip(chip.id)}
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        {props.attach.allowed ? (
          <>
            <input
              ref={picker}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              accept={props.attach.accept}
              multiple={props.attach.maxFiles > 1}
              onChange={(e) => {
                props.onFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
              data-testid="file-input"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              aria-label={t('surface.files.attach')}
              aria-describedby={hintId}
              onClick={() => picker.current?.click()}
            >
              <PaperclipIcon className="size-5" aria-hidden="true" />
            </Button>
            <span id={hintId} className="sr-only">
              {t('surface.files.hint', { size: props.attach.maxMb })}
            </span>
          </>
        ) : null}
        <ComposerPrimitive.Input
          aria-label={props.label}
          placeholder={props.label}
          maxLength={10_000}
          dir={directionOf(text)}
          rows={1}
          submitMode="none"
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          className="min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-input bg-bg px-3 py-2.5 text-base text-text"
        />
        {text.trim() ? (
          <ComposerPrimitive.Send asChild>
            <Button className="min-h-11" aria-disabled={uploading || undefined}>
              <SendLabel text={props.send} />
            </Button>
          </ComposerPrimitive.Send>
        ) : (
          <Button
            type="submit"
            className="min-h-11"
            disabled={!ready || uploading}
            data-testid="send-files"
          >
            <SendLabel text={props.send} />
          </Button>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}

/** Reports what the visitor saw while the newest messages are on screen (W05, W06). */
function SeenReporter({
  visible,
  onSeen,
  latest,
}: {
  visible: boolean;
  onSeen: () => void;
  latest: number;
}) {
  const atBottom = useThreadViewport((s) => s.isAtBottom);
  // biome-ignore lint/correctness/useExhaustiveDependencies: run again when new events arrive
  useEffect(() => {
    if (!visible || !atBottom) return;
    const report = () => {
      if (document.visibilityState === 'visible') onSeen();
    };
    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, [visible, atBottom, onSeen, latest]);
  return null;
}

type View = 'chat' | 'memory' | 'settings' | 'conversations' | 'contact';

/**
 * What the visitor did before the first conversation, kept while the chat asks its pre-chat form
 * or for consent (W26, W27): a message, "talk to a person", or files to attach.
 */
type Intent = { kind: 'send'; text: string } | { kind: 'handoff' } | { kind: 'files' };

/** Puts focus back in the message box, after it comes back. */
const focusComposer = () =>
  requestAnimationFrame(() =>
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label]')?.focus(),
  );

export function Chat(props: {
  client: HamnivoClient;
  session: WidgetSession;
  state: ChatState;
  commerce: Commerce;
  pending: readonly OutgoingMessage[];
  locale: Locale;
  mode: WidgetLayoutMode;
  /** Whether the chat is on screen (the frame is open and the page shown). */
  visible: boolean;
  display: DisplayControls;
  /** The proactive prompt the visitor opened the chat from (W19). */
  prompt: string | null;
  /** The name of the person typing a reply ('' when unnamed), or null when nobody is. */
  staffTyping: string | null;
  /** Says the website notes which pages are viewed (from the gateway), or null. */
  visitorNotice: string | null;
  onLocale: (locale: Locale) => void;
  onSend: (text: string, attachments?: readonly OutgoingAttachment[]) => Promise<void>;
  onRetry: (clientMessageId: string) => void;
  onRemove: (clientMessageId: string) => OutgoingMessage | null;
  onFlush: () => void;
  onHandoff: () => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onSeen: () => void;
  onDelete: (messageId: string) => Promise<void>;
  onReact: (messageId: string, emoji: ReactionEmoji) => Promise<void>;
  onOpenConversation: (conversationId: string) => Promise<void>;
  onFilesConversation: () => Promise<string | null>;
  /** Starts the first conversation with the pre-chat answers and first message (W26). */
  onStart: (input: StartConversationInput) => Promise<void>;
  /** Opens the closed conversation on screen again (W15). */
  onReopen: () => Promise<void>;
  /** Leaves a message while nobody can answer (W11); it becomes a ticket (H19). */
  onLeaveMessage: (
    answers: FormAnswers,
    clientRequestId: string,
  ) => Promise<OfflineMessageResponse>;
  /** The gateway asked for consent again: the chat asks with the words now in force (W27). */
  onConsentRequired: () => Promise<void>;
  /** Notes a refusal because chat isn't available (H20); true when it was one. */
  onUnavailable: (error: unknown) => boolean;
  onClose?: (() => void) | undefined;
  language: {
    state: WidgetLanguageState | null;
    choose: (language: ReplyLanguage) => Promise<void>;
    dismiss: () => Promise<void>;
  };
  memory: MemoryControls;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { session, state, locale, memory, client } = props;
  const config = session.config;
  const [view, setView] = useState<View>('chat');
  const [more, setMore] = useState(false);
  const [askLater, setAskLater] = useState(false);
  const [chips, setChips] = useState<Chip[]>([]);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const moreId = useId();
  const remembered = memory.state.memory;
  // When memory can't be loaded, the entry stays so the customer can see why (HNV-15-06).
  const memoryShown =
    memory.state.phase === 'error' ||
    (remembered !== null &&
      (remembered.offered ||
        remembered.items.length > 0 ||
        remembered.consent.state === 'granted'));
  const askConsent =
    remembered?.offered === true && remembered.consent.state === 'undecided' && !askLater;
  const show = (next: View) => {
    setMore(false);
    setView(next);
    if (next === 'memory') void memory.reload();
  };
  const back = (focus: string) => {
    setView('chat');
    requestAnimationFrame(() => document.getElementById(focus)?.focus());
  };
  const copy = config.copy[locale] ?? config.copy.en;
  const conversation = state.conversation;
  const offline = state.connection === 'offline';
  // Chat isn't available to this visitor (H20): help, reading and privacy choices still work, and
  // the chat says only that chat isn't available, never why.
  const available = chatAvailable(state);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const messages = useMemo(
    () => toThread(state.messages, props.pending, t('you'), state.firstUnreadId, state.drafts),
    [state.messages, props.pending, t, state.firstUnreadId, state.drafts],
  );
  const canAskPerson =
    available &&
    conversation?.responder !== 'person' &&
    conversation?.status !== 'waiting_for_person';
  const last = state.messages.at(-1);
  const aiWriting =
    conversation?.responder === 'ai' &&
    last?.sender.kind === 'customer' &&
    Date.now() - Date.parse(last.createdAt) < 60_000;

  // Announce replies from others once, not every render (UX flow spec §4).
  const announced = useRef(new Set<string>());
  useEffect(() => {
    for (const m of state.messages) {
      if (m.sender.kind === 'customer' || announced.current.has(m.id)) continue;
      announced.current.add(m.id);
      if (announced.current.size > 1 || state.messages.length === 1)
        announce(
          `${m.sender.displayName}: ${spokenOf(m, (name) => t('surface.files.picture', { name }))}`,
        );
    }
  }, [announce, state.messages, t]);

  const readyFiles = () =>
    chipsRef.current.flatMap((c) => (c.state === 'ready' && c.file ? [c.file] : []));
  const draftScope = `${session.principal.id}:${conversation?.id ?? 'new'}`;

  // Before the first conversation the chat may ask its pre-chat form, or for consent (W26, W27).
  // The visitor's first step (a message, "talk to a person", files) waits for it, then goes on.
  const askPrechat = prechatNeeded(session);
  const mustAgree = consentNeeded(config);
  const gated = !conversation && (askPrechat || mustAgree);
  const [gate, setGate] = useState<{ intent: Intent; messageId: string } | null>(null);
  /** Files waiting for the conversation the gate starts (null when the visitor stepped back). */
  const fileWaiters = useRef<Array<(conversationId: string | null) => void>>([]);
  /** Answers given in this visit, so a second try starts from them; never stored. */
  const prechatAnswers = useRef<FieldValues>({});
  const contactAnswers = useRef<FieldValues>({});
  const newScope = `${session.principal.id}:new`;

  const releaseFiles = (conversationId: string | null) => {
    for (const resolve of fileWaiters.current.splice(0)) resolve(conversationId);
  };
  // Another person (signed in or out) starts with nothing asked and nothing remembered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the person changes
  useEffect(() => {
    setGate(null);
    releaseFiles(null);
    prechatAnswers.current = {};
    contactAnswers.current = {};
    setView((current) => (current === 'contact' ? 'chat' : current));
  }, [session.principal.id]);

  // When a write is refused because chat isn't available, nothing waits to start a chat or leave
  // a message any more; the visitor hears it once, and focus does not get lost with the message box.
  const wasAvailable = useRef(available);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when availability changes
  useEffect(() => {
    if (available) {
      wasAvailable.current = true;
      return;
    }
    setGate(null);
    releaseFiles(null);
    setView((current) => (current === 'contact' ? 'chat' : current));
    if (!wasAvailable.current) return;
    wasAvailable.current = false;
    announce(t('surface.unavailable.notice'));
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) noticeRef.current?.focus();
    });
  }, [available]);

  const openGate = (intent: Intent) => {
    // What the visitor wrote stays on this device as a draft until the chat starts.
    if (intent.kind === 'send') client.drafts.set(newScope, intent.text);
    setGate((current) => current ?? { intent, messageId: crypto.randomUUID() });
  };
  const waitForGate = (intent: Intent) =>
    new Promise<string | null>((resolve) => {
      fileWaiters.current.push(resolve);
      openGate(intent);
    });
  /** The gateway wants consent the chat thought it had (new words): ask, then go on. */
  const askAgain = async (error: unknown, intent: Intent) => {
    if (conversation || !isConsentRequired(error)) throw error;
    await props.onConsentRequired();
    openGate(intent);
  };

  const send = async (text: string, files: readonly OutgoingAttachment[] = []) => {
    if (gated) return openGate({ kind: 'send', text });
    try {
      await props.onSend(text, files);
    } catch (error) {
      await askAgain(error, { kind: 'send', text });
    }
  };
  const handoff = async () => {
    if (gated) return openGate({ kind: 'handoff' });
    try {
      await props.onHandoff();
    } catch (error) {
      await askAgain(error, { kind: 'handoff' });
    }
  };
  const filesConversation = async (): Promise<string | null> => {
    if (gated) return waitForGate({ kind: 'files' });
    try {
      return await props.onFilesConversation();
    } catch (error) {
      if (conversation || !isConsentRequired(error)) throw error;
      await props.onConsentRequired();
      return waitForGate({ kind: 'files' });
    }
  };

  /**
   * Agrees when asked, then starts the chat. With the pre-chat form the answers go with the start,
   * and so does the first message; with consent alone the first step simply goes on.
   */
  const passGate = async (answers: FormAnswers, values: FieldValues) => {
    if (!gate) return;
    const { intent, messageId } = gate;
    if (mustAgree) await client.giveConsent(config.consent.noticeVersion);
    if (askPrechat) {
      const pending = intent.kind === 'send' ? intent.text : '';
      const firstMessage = firstMessageOf(config.forms.prechat.fields, values, pending);
      await props.onStart({
        prechat: answers,
        ...(firstMessage ? { firstMessage, clientMessageId: messageId } : {}),
      });
    } else if (intent.kind === 'send') {
      await props.onSend(intent.text);
    } else {
      await props.onStart({});
    }
    client.drafts.clear(newScope);
    prechatAnswers.current = {};
    setGate(null);
    releaseFiles(await props.onFilesConversation().catch(() => null));
    focusComposer();
    // The chat has started; asking for a person goes as it always does.
    if (intent.kind === 'handoff') await props.onHandoff().catch(() => undefined);
  };

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (m) => m,
    isRunning: aiWriting,
    onNew: async (append) => {
      const text = append.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
      const files = readyFiles();
      setChips([]);
      client.drafts.clear(draftScope);
      try {
        await send(text, files);
      } catch {
        // Not sent (for example offline before the conversation existed): the words come back.
        runtime.thread.composer.setText(text);
      }
    },
  });

  /** "Not now": the visitor's words go back in the message box, and files are not attached. */
  const cancelGate = () => {
    if (gate?.intent.kind === 'send') runtime.thread.composer.setText(gate.intent.text);
    setGate(null);
    releaseFiles(null);
    focusComposer();
  };

  const sendFiles = () => {
    const files = readyFiles();
    if (!files.length) return;
    setChips([]);
    void props.onSend('', files);
  };

  const limits = config.attachmentLimits;
  const maxFiles = limits.maxFiles;
  const maxMb = Math.round(limits.maxBytes / (1024 * 1024));
  const reasonText = (reason: string | undefined) =>
    reason && t(`surface.files.reasons.${reason}`, { defaultValue: '', size: maxMb })
      ? t(`surface.files.reasons.${reason}`, { size: maxMb })
      : t('surface.files.reasons.unreadable');
  const addFiles = async (files: File[]) => {
    const room = Math.max(
      0,
      maxFiles - chipsRef.current.filter((c) => c.state !== 'refused').length,
    );
    if (files.length > room) announce(t('surface.files.limit', { count: maxFiles }));
    const accepted = files.slice(0, room);
    if (!accepted.length) return;
    const added = accepted.map((file) => {
      const local =
        !limits.allowedMimeTypes.includes(file.type) && file.type !== ''
          ? 'type_not_allowed'
          : file.size > limits.maxBytes
            ? 'too_large'
            : null;
      return {
        chip: {
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          state: local ? 'refused' : 'uploading',
          ...(local ? { reason: reasonText(local) } : {}),
        } satisfies Chip,
        file,
        refused: local !== null,
      };
    });
    setChips((current) => [...current, ...added.map((a) => a.chip)]);
    const conversationId = await filesConversation().catch(() => null);
    for (const { chip, file, refused } of added) {
      if (refused) continue;
      const update = (patch: Partial<Chip>) =>
        setChips((current) => current.map((c) => (c.id === chip.id ? { ...c, ...patch } : c)));
      if (!conversationId) {
        update({ state: 'refused', reason: t('surface.files.loadFailed') });
        continue;
      }
      try {
        const part = await client.uploadAttachment(conversationId, file, file.name);
        update({
          state: 'ready',
          name: part.name,
          file: {
            uploadId: part.uploadId,
            name: part.name,
            mimeType: part.mimeType,
            sizeBytes: part.sizeBytes,
          },
        });
        announce(`${part.name}: ${t('surface.files.ready')}`);
      } catch (error) {
        props.onUnavailable(error);
        const reason =
          error instanceof HamnivoApiError
            ? error.code === 'FEATURE_DISABLED'
              ? t('surface.files.reasons.disabled')
              : reasonText(String(error.problem.reason ?? ''))
            : t('surface.files.loadFailed');
        update({ state: 'refused', reason });
        announce(`${file.name}: ${reason}`);
      }
    }
  };

  /** Takes an unsent message back into the message box, with its files. */
  const edit = (clientMessageId: string) => {
    const item = props.onRemove(clientMessageId);
    if (!item) return;
    runtime.thread.composer.setText(item.text);
    if (item.attachments?.length) {
      setChips((current) => [
        ...current,
        ...(item.attachments ?? []).map((file) => ({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.sizeBytes,
          state: 'ready' as const,
          file,
        })),
      ]);
    }
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label]')?.focus(),
    );
  };

  const ctx: BubbleContext = {
    client,
    conversationId: conversation?.id ?? null,
    commerce: props.commerce,
    locale,
    offline,
    deleteWindowMs: (config.messageDeletion?.windowSeconds ?? 0) * 1000,
    readOnly: !available,
    onRetry: props.onRetry,
    onEdit: edit,
    onRemove: (id) => {
      props.onRemove(id);
    },
    onHelp: canAskPerson ? () => void handoff() : undefined,
    onOpenMemory: () => show('memory'),
    onDelete: props.onDelete,
    onReact: props.onReact,
  };

  const banner =
    conversation?.status === 'waiting_for_person'
      ? (state.handoffNotice ?? t('waitingForPerson'))
      : conversation?.status === 'with_person'
        ? t('withPerson')
        : conversation?.status === 'resolved'
          ? t('resolved')
          : null;
  const lastSync = state.lastSync
    ? new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(state.lastSync))
    : null;
  const proactive = props.prompt ? { brand: config.brand.name, text: props.prompt } : null;
  const allowFiles = config.features.attachments;
  // A message left while nobody could answer is listed even before a chat is on screen.
  const hasOthers = state.conversations.some((c) => c.id !== conversation?.id);
  const empty = state.messages.length === 0 && props.pending.length === 0;
  const centered = props.mode === 'fullpage';
  const resolved = conversation?.status === 'resolved';
  const reopen = async () => {
    await props.onReopen();
    focusComposer();
  };
  // Who can answer is said on the home screen; the header says it while home is out of sight.
  const statusInHeader =
    empty && Boolean(config.availability) && (view !== 'chat' || gate !== null);
  const contact = available && offlineFormApplies(config) ? () => show('contact') : null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section
        aria-label={config.brand.name}
        className={`flex h-full flex-col ${centered ? 'mx-auto w-full max-w-2xl' : ''}`}
        data-conversation-id={conversation?.id ?? ''}
        data-mode={props.mode}
      >
        <header className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-3">
          <BrandMark url={config.brand.logoUrl} />
          <div className="min-w-0 flex-1 basis-40">
            <h1 className="truncate text-base font-semibold text-text">{config.brand.name}</h1>
            <p className="text-sm text-text-muted" data-testid="ai-disclosure">
              {copy.aiDisclosure}
            </p>
            {conversation?.ticket ? (
              <p className="mt-1 text-xs text-text-muted" data-testid="header-ticket">
                <TicketLine ticket={conversation.ticket} />
              </p>
            ) : null}
            {statusInHeader ? (
              <div className="mt-1">
                <StatusLine availability={config.availability} locale={locale} compact />
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {memoryShown ? (
              <Button
                id="hv-memory-open"
                variant="ghost"
                className="h-10 px-2 text-sm"
                aria-pressed={view === 'memory'}
                onClick={() => (view === 'memory' ? back('hv-memory-open') : show('memory'))}
              >
                {t('memory.open')}
              </Button>
            ) : null}
            <Button
              id="hv-more"
              variant="ghost"
              className="h-10 px-2 text-sm"
              aria-expanded={more}
              aria-controls={moreId}
              aria-label={t('surface.moreLabel')}
              onClick={() => setMore((open) => !open)}
            >
              {t('surface.more')}
            </Button>
            <label className="sr-only" htmlFor="hv-locale">
              {t('language')}
            </label>
            <select
              id="hv-locale"
              className="h-10 max-w-full rounded-md border border-input bg-surface px-2 text-sm"
              value={locale}
              onChange={(e) => props.onLocale(e.target.value as Locale)}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_NAMES[l]}
                </option>
              ))}
            </select>
            {props.onClose ? (
              <Button variant="ghost" size="icon" aria-label={t('close')} onClick={props.onClose}>
                ×
              </Button>
            ) : null}
          </div>
          {more ? (
            <ul id={moreId} className="flex w-full flex-wrap gap-2" data-testid="more-menu">
              {hasOthers ? (
                <li>
                  <Button
                    id="hv-conversations-open"
                    variant="outline"
                    size="sm"
                    onClick={() => show('conversations')}
                  >
                    {t('surface.conversations.title')}
                  </Button>
                </li>
              ) : null}
              <li>
                <Button
                  id="hv-settings-open"
                  variant="outline"
                  size="sm"
                  onClick={() => show('settings')}
                >
                  {t('surface.settings.title')}
                </Button>
              </li>
            </ul>
          ) : null}
        </header>
        {banner ? (
          <div className="flex flex-col gap-2 border-b border-border bg-surface-sunken px-4 py-2">
            <p role="status" className="text-sm text-text" data-testid="status-banner">
              {banner}
            </p>
            {/* Without a rating to ask, the banner is where to open the conversation again. */}
            {resolved && !config.features.csat && available ? <Reopen onReopen={reopen} /> : null}
          </div>
        ) : null}
        {config.features.csat && conversation && resolved && available ? (
          <Csat client={client} conversationId={conversation.id} onReopen={reopen} />
        ) : null}
        {offline ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-warning-subtle px-4 py-1.5 text-xs text-text"
            data-testid="connection"
          >
            <span>
              {t('surface.offline.banner')}
              {lastSync ? ` ${t('surface.offline.lastSync', { time: lastSync })}` : ''}
            </span>
            <Button variant="link" className="h-auto text-xs" onClick={props.onFlush}>
              {t('surface.offline.tryAgain')}
            </Button>
          </div>
        ) : state.connection === 'reconnecting' ? (
          <p
            role="status"
            className="bg-warning-subtle px-4 py-1.5 text-xs text-text"
            data-testid="connection"
          >
            {t('reconnecting')}
          </p>
        ) : null}
        {view === 'memory' ? (
          <MemoryPanel controls={memory} onBack={() => back('hv-memory-open')} />
        ) : null}
        {view === 'settings' ? (
          <Settings
            client={client}
            person={session.principal.id}
            display={props.display}
            emails={config.notifications?.email !== false}
            onBack={() => back('hv-more')}
          />
        ) : null}
        {view === 'conversations' ? (
          <Conversations
            conversations={state.conversations}
            current={conversation?.id ?? null}
            locale={locale}
            onOpen={(id) => {
              setView('chat');
              void props.onOpenConversation(id);
            }}
            onBack={() => back('hv-more')}
          />
        ) : null}
        {view === 'contact' ? (
          <ContactForm
            config={config}
            locale={locale}
            remembered={contactAnswers.current}
            onValues={(values) => {
              contactAnswers.current = values;
            }}
            onAgree={() => client.giveConsent(config.consent.noticeVersion)}
            onLeave={async (answers, clientRequestId) => {
              const sent = await props.onLeaveMessage(answers, clientRequestId);
              contactAnswers.current = {};
              return sent;
            }}
            onConsentRequired={props.onConsentRequired}
            onBack={() => back('hv-contact-open')}
          />
        ) : null}
        <ThreadPrimitive.Root
          className={view === 'chat' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        >
          <SeenReporter
            visible={props.visible && view === 'chat'}
            onSeen={props.onSeen}
            latest={state.latestSequence}
          />
          {/* Focusable so keyboard users can scroll it even when no card has a control. */}
          <ThreadPrimitive.Viewport
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
            tabIndex={0}
            aria-label={t('title')}
          >
            {state.olderCursor ? (
              <div className="mb-3 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  busy={state.loadingOlder}
                  onClick={() => void props.onLoadOlder()}
                  data-testid="older"
                >
                  {state.loadingOlder ? t('surface.history.loading') : t('surface.history.older')}
                </Button>
              </div>
            ) : null}
            {gate ? (
              <StartGate
                fields={askPrechat ? config.forms.prechat.fields : []}
                consent={
                  mustAgree
                    ? {
                        text: labelOf(config.consent.text, locale),
                        privacyPolicyUrl: config.privacyPolicyUrl,
                      }
                    : null
                }
                pending={gate.intent.kind === 'send' ? gate.intent.text : ''}
                remembered={prechatAnswers.current}
                locale={locale}
                onSubmit={passGate}
                onConsentRequired={props.onConsentRequired}
                onValues={(values) => {
                  prechatAnswers.current = values;
                }}
                onCancel={cancelGate}
              />
            ) : empty ? (
              <Home
                client={client}
                greeting={copy.greeting}
                prompt={proactive}
                suggestions={config.help?.suggestions?.[locale] ?? []}
                search={config.features.helpCenter}
                availability={config.availability}
                locale={locale}
                onContact={contact}
                available={available}
                onAsk={(question) => void send(question)}
              />
            ) : null}
            {askConsent && remembered ? (
              <MemoryConsent
                maxRetentionDays={remembered.maxRetentionDays}
                privacyPolicyUrl={config.privacyPolicyUrl}
                onLater={() => setAskLater(true)}
                onChoose={async (choice) => {
                  await memory.setConsent(choice);
                  announce(
                    t(choice === 'granted' ? 'memory.switch.turnedOn' : 'memory.consent.declined'),
                  );
                }}
              />
            ) : null}
            <ul className="flex flex-col gap-4" aria-label={t('title')}>
              <ThreadPrimitive.Messages>
                {({ message }) => (
                  <Bubble message={message as unknown as ThreadMessageLike} ctx={ctx} />
                )}
              </ThreadPrimitive.Messages>
            </ul>
            {state.unread > 0 ? (
              <div className="pointer-events-none sticky bottom-2 mt-2 flex justify-center">
                <ThreadPrimitive.ScrollToBottom
                  asChild
                  behavior={props.display.reduced ? 'auto' : 'smooth'}
                >
                  <Button
                    size="sm"
                    className="pointer-events-auto shadow-md disabled:hidden"
                    data-testid="jump-new"
                  >
                    {t('surface.history.jump', { count: state.unread })}
                  </Button>
                </ThreadPrimitive.ScrollToBottom>
              </div>
            ) : null}
          </ThreadPrimitive.Viewport>
          <div className="border-t border-border bg-surface px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {available ? <ShopBar commerce={props.commerce} locale={locale} /> : null}
            {/* While the chat asks before starting, its card is the one thing to answer. */}
            {!available ? (
              <>
                <p
                  ref={noticeRef}
                  tabIndex={-1}
                  className="mb-1 rounded-xl bg-surface-sunken px-3 py-2.5 text-sm text-text outline-none"
                  data-testid="chat-unavailable"
                >
                  {t('surface.unavailable.notice')}
                </p>
                <VisitorNotice text={props.visitorNotice} />
              </>
            ) : gate ? null : (
              <>
                {canAskPerson ? (
                  <Button
                    variant="link"
                    className="mb-1 h-auto text-sm"
                    onClick={() => void handoff()}
                  >
                    {t('talkToPerson')}
                  </Button>
                ) : null}
                <LanguageQuestion
                  state={props.language.state}
                  onChoose={props.language.choose}
                  onDismiss={props.language.dismiss}
                />
                <StaffTypingLine name={props.staffTyping} />
                <VisitorNotice text={props.visitorNotice} />
                <Composer
                  label={t('placeholder')}
                  send={offline ? t('surface.offline.queue') : t('send')}
                  draftScope={draftScope}
                  conversationId={conversation?.id ?? null}
                  client={client}
                  chips={chips}
                  attach={{
                    allowed: allowFiles,
                    accept: limits.allowedMimeTypes.join(','),
                    maxFiles,
                    maxMb: Math.round(limits.maxBytes / (1024 * 1024)),
                  }}
                  onFiles={(files) => void addFiles(files)}
                  onRemoveChip={(id) => setChips((current) => current.filter((c) => c.id !== id))}
                  onSendFiles={sendFiles}
                  locale={locale}
                />
              </>
            )}
            <PrivacyLink url={config.privacyPolicyUrl} />
          </div>
        </ThreadPrimitive.Root>
      </section>
    </AssistantRuntimeProvider>
  );
}
