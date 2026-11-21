import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  ThreadPrimitive,
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
  FormAnswers,
  OfflineMessageResponse,
  ReactionEmoji,
  ReplyLanguage,
  WidgetLanguageState,
  WidgetLayoutMode,
  WidgetSession,
} from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { Skeleton } from '@hamnivo/ui/components/skeleton';
import {
  ArrowDownIcon,
  BrainIcon,
  MessagesSquareIcon,
  SettingsIcon,
  UserRoundIcon,
  WifiOffIcon,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { offlineFormApplies } from '../availability.js';
import { ShopBar } from '../commerce/ShopBar.js';
import type { Commerce } from '../commerce/useCommerce.js';
import {
  consentNeeded,
  type FieldValues,
  firstMessageOf,
  isConsentRequired,
  labelOf,
  prechatNeeded,
} from '../forms.js';
import { type Locale, REPLY_LANGUAGE_NAMES } from '../i18n.js';
import { runIsLive } from '../run.js';
import { type ChatState, chatAvailable } from '../useChat.js';
import type { DisplayControls } from '../useDisplay.js';
import type { MemoryControls } from '../useMemory.js';
import { Csat } from './Csat.js';
import { type Chip, Composer } from './composer/Composer.js';
import { useFileDrop } from './composer/useFileDrop.js';
import { Home } from './Home.js';
import { MemoryConsent } from './MemoryConsent.js';
import { FinePrint } from './PrivacyLink.js';
import { Reopen } from './Reopen.js';
import { StaffTypingLine } from './StaffTyping.js';
import { StatusLine } from './StatusLine.js';
import { Header } from './shell/Header.js';
import { TicketLine } from './TicketLine.js';
import { Bubble, type BubbleContext } from './thread/Bubble.js';
import { DraftBubble } from './thread/Draft.js';
import { type Custom, deletedOf, reactionOf, spokenOf, toThread } from './thread/model.js';
import { Thinking } from './thread/Thinking.js';
import { VisitorNotice } from './VisitorNotice.js';

// Screens a visitor may never open load when they are first asked for.
const MemoryPanel = lazy(() =>
  import('./MemoryPanel.js').then((module) => ({ default: module.MemoryPanel })),
);
const Settings = lazy(() =>
  import('./Settings.js').then((module) => ({ default: module.Settings })),
);
const Conversations = lazy(() =>
  import('./Conversations.js').then((module) => ({ default: module.Conversations })),
);
const ContactForm = lazy(() =>
  import('./ContactForm.js').then((module) => ({ default: module.ContactForm })),
);
const StartGate = lazy(() =>
  import('./StartGate.js').then((module) => ({ default: module.StartGate })),
);

/** How long after the visitor wrote a reply is still shown as on its way, without any word of it. */
const REPLY_DUE_MS = 45_000;

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
      className="hv-enter mb-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-sm"
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

/**
 * The way back to the newest message while reading earlier ones (HNV-06-06). With replies not
 * seen yet it says how many wait; otherwise it is a small arrow. New messages never move the
 * page by themselves once the visitor has scrolled up.
 */
function JumpToLatest({ unread, smooth }: { unread: number; smooth: boolean }) {
  const { t } = useTranslation();
  const atBottom = useThreadViewport((s) => s.isAtBottom);
  if (unread > 0) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
        <ThreadPrimitive.ScrollToBottom asChild behavior={smooth ? 'smooth' : 'auto'}>
          <Button
            size="sm"
            className="hv-pop pointer-events-auto rounded-full shadow-md disabled:hidden"
            data-testid="jump-new"
          >
            {t('surface.history.jump', { count: unread })}
          </Button>
        </ThreadPrimitive.ScrollToBottom>
      </div>
    );
  }
  if (atBottom) return null;
  return (
    <div className="pointer-events-none absolute end-3 bottom-2 flex">
      <ThreadPrimitive.ScrollToBottom asChild behavior={smooth ? 'smooth' : 'auto'}>
        <Button
          variant="secondary"
          size="icon"
          className="hv-pop pointer-events-auto rounded-full shadow-md disabled:hidden"
          aria-label={t('ui.latest')}
          title={t('ui.latest')}
          data-testid="jump-latest"
        >
          <ArrowDownIcon className="size-5" aria-hidden="true" />
        </Button>
      </ThreadPrimitive.ScrollToBottom>
    </div>
  );
}

/**
 * "Back to the assistant" while a request for a person waits (HNV-10-02, HNV-10-05). It can be
 * pressed once at a time; the answer replaces the banner, and focus moves to the composer when
 * the assistant answers again.
 */
function BackToAssistant({ onCancel }: { onCancel: () => Promise<void> }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="[@media(max-height:26rem)]:h-8"
      disabled={busy}
      aria-busy={busy || undefined}
      data-testid="back-to-assistant"
      onClick={async () => {
        setBusy(true);
        try {
          await onCancel();
        } catch {
          // The banner stays as it was; the reason, if any, is shown by the chat.
        } finally {
          setBusy(false);
        }
      }}
    >
      {t('backToAssistant')}
    </Button>
  );
}

/** A screen that is still on its way: its shape, with words for screen readers. */
function PanelLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4" role="status">
      <span className="sr-only">{t('ui.loading')}</span>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  );
}

/** Whether a media query matches, kept up to date as the frame changes. */
function useMedia(media: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof matchMedia === 'function' && matchMedia(media).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(media);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [media]);
  return matches;
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
  /** Words the website put in the message box (Hamnivo.prefill); `at` tells repeats apart. */
  prefill: { text: string; at: number } | null;
  /** The name of the person typing a reply ('' when unnamed), or null when nobody is. */
  staffTyping: string | null;
  /** Says the website notes which pages are viewed (from the gateway), or null. */
  visitorNotice: string | null;
  /** The header in the brand's colour, or plain like the rest of the chat. */
  headerStyle?: 'brand' | 'plain' | undefined;
  /** Makes the chat larger or smaller, where the website's loader can; null otherwise. */
  expand?: { expanded: boolean; onToggle: () => void } | null | undefined;
  onLocale: (locale: Locale) => void;
  onSend: (text: string, attachments?: readonly OutgoingAttachment[]) => Promise<void>;
  onRetry: (clientMessageId: string) => void;
  onRemove: (clientMessageId: string) => OutgoingMessage | null;
  onFlush: () => void;
  onHandoff: () => Promise<void>;
  /** Withdraws the request for a person while nobody has the chat (HNV-10-02). */
  onCancelHandoff: () => Promise<void>;
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
  /** Puts away a problem that did not stop the chat. */
  onDismissError?: (() => void) | undefined;
  /** Loads the conversation again after a problem. */
  onReconnect?: (() => void) | undefined;
  /** Stops the answer being written, where the gateway can; absent otherwise. */
  onStop?: (() => void) | undefined;
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
  // Too short for everything at once: a phone held sideways, a zoomed window.
  const short = useMedia('(max-height: 26rem)');
  // A phone's width: "talk to a person" is a round button beside the message box, not a line
  // above it, so the conversation keeps the height (production-ready plan: under 170 px of
  // header, buttons, message box and small print at 390 × 844).
  // Below 16rem (a 200 % zoom) the row has no room for it, and it goes back above the box.
  const compact = useMedia('(min-width: 16rem) and (max-width: 30rem)') || short;
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
  const you = t('you');
  const messages = useMemo(
    () => toThread(state.messages, props.pending, you, state.firstUnreadId),
    [state.messages, props.pending, you, state.firstUnreadId],
  );
  const canAskPerson =
    available &&
    conversation?.responder !== 'person' &&
    conversation?.status !== 'waiting_for_person' &&
    conversation?.status !== 'with_person';

  // A reply is on its way: the gateway says what the assistant is doing, or, where it says
  // nothing, the visitor's newest message is still young. A reaction or a deleted message is
  // nothing to answer. The clock is read again every few seconds, so the sign ends on time.
  const [now, setNow] = useState(() => Date.now());
  const newest = state.messages.findLast((m) => !reactionOf(m));
  const owed =
    conversation?.responder === 'ai' &&
    newest !== undefined &&
    newest.sender.kind === 'customer' &&
    !deletedOf(newest);
  const asked =
    conversation?.responder === 'ai' || !conversation
      ? (state.awaitingSince ?? (owed && newest ? Date.parse(newest.createdAt) : null))
      : null;
  const due =
    asked !== null &&
    now - asked < REPLY_DUE_MS &&
    !(state.runEndedAt !== null && state.runEndedAt >= asked);
  const working = runIsLive(state.run, now);
  const replying = (working || due) && available;
  useEffect(() => {
    if (!(asked !== null || state.run !== null)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [asked, state.run]);

  // Announce replies from others once, not every render (UX flow spec §4).
  // What is already there when the chat opens (its history) is not read out; only what comes after.
  const announced = useRef(new Set<string>());
  useEffect(() => {
    const opening = announced.current.size === 0 && state.messages.length > 1;
    for (const m of state.messages) {
      if (m.sender.kind === 'customer' || announced.current.has(m.id)) continue;
      announced.current.add(m.id);
      if (!opening)
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
  /** When the website's words last went in the box (Hamnivo.prefill). */
  const prefillUsed = useRef(0);
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

  // The chat shows by itself that a reply is on its way and lets the visitor write meanwhile,
  // so the thread is never "running" for the message box.
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (m) => m,
    onNew: async (append) => {
      const text = append.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
      const taken = chipsRef.current;
      const files = readyFiles();
      setChips([]);
      client.drafts.clear(draftScope);
      try {
        await send(text, files);
      } catch {
        // Not sent (for example offline before the conversation existed): the words and the
        // files come back.
        runtime.thread.composer.setText(text);
        setChips((current) => (current.length ? current : taken));
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
    const taken = chipsRef.current;
    const files = readyFiles();
    if (!files.length) return;
    setChips([]);
    // Files alone go the way words do; when that fails, they stay attached.
    send('', files).catch(() => setChips((current) => (current.length ? current : taken)));
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
    focusComposer();
  };

  // What bubbles call. The bubbles keep one context between renders, so a new reply does not
  // redraw the whole conversation; the newest functions are reached through this.
  const calls = useRef({
    onRetry: props.onRetry,
    onEdit: edit,
    onRemove: props.onRemove,
    onHelp: handoff,
    onOpenMemory: () => show('memory'),
    onDelete: props.onDelete,
    onReact: props.onReact,
    onAsk: send,
  });
  calls.current = {
    onRetry: props.onRetry,
    onEdit: edit,
    onRemove: props.onRemove,
    onHelp: handoff,
    onOpenMemory: () => show('memory'),
    onDelete: props.onDelete,
    onReact: props.onReact,
    onAsk: send,
  };
  const conversationId = conversation?.id ?? null;
  // Messages written from now on arrive with a small movement; the history just shown does not.
  const [freshAfter, setFreshAfter] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: again for each conversation shown
  useEffect(() => setFreshAfter(Date.now()), [conversationId]);
  const deleteWindowMs = (config.messageDeletion?.windowSeconds ?? 0) * 1000;
  const logoUrl = config.brand.logoUrl;
  const ctx = useMemo<BubbleContext>(
    () => ({
      client,
      conversationId,
      locale,
      offline,
      deleteWindowMs,
      readOnly: !available,
      logoUrl,
      freshAfter,
      canAskPerson,
      onRetry: (id) => calls.current.onRetry(id),
      onEdit: (id) => calls.current.onEdit(id),
      onRemove: (id) => {
        calls.current.onRemove(id);
      },
      onHelp: () => void calls.current.onHelp(),
      onOpenMemory: () => calls.current.onOpenMemory(),
      onDelete: (id) => calls.current.onDelete(id),
      onReact: (id, emoji) => calls.current.onReact(id, emoji),
      onAsk: (text) => void calls.current.onAsk(text),
    }),
    [
      client,
      conversationId,
      locale,
      offline,
      deleteWindowMs,
      available,
      logoUrl,
      freshAfter,
      canAskPerson,
    ],
  );

  const waiting = conversation?.status === 'waiting_for_person';
  // A person has the chat: the banner says who, by the name they chose, once they have written.
  const personName =
    conversation?.status === 'with_person' || conversation?.responder === 'person'
      ? state.messages.findLast((m) => m.sender.kind === 'human_agent')?.sender.displayName
      : undefined;
  const banner = waiting
    ? (state.handoffNotice ?? t('waitingForPerson'))
    : conversation?.status === 'with_person'
      ? personName
        ? t('withNamedPerson', { name: personName })
        : t('withPerson')
      : conversation?.status === 'resolved'
        ? t('resolved')
        : conversation?.responder === 'ai'
          ? state.assistantNotice
          : null;
  // Waiting because they asked, and nobody has the chat yet: they may change their mind.
  const canGoBack = waiting && conversation.canReturnToAssistant && available && !offline;
  const lastSync = state.lastSync
    ? new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(state.lastSync))
    : null;
  const proactive = props.prompt ? { brand: config.brand.name, text: props.prompt } : null;
  // The website's words go in once: the box coming back (after a form) keeps what the visitor typed.
  const prefill = props.prefill && props.prefill.at > prefillUsed.current ? props.prefill : null;
  const allowFiles = config.features.attachments;
  // A message left while nobody could answer is listed even before a chat is on screen.
  const others = state.conversations.filter((c) => c.id !== conversation?.id);
  const hasOthers = others.length > 0;
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
  const drop = useFileDrop(allowFiles && available && view === 'chat' && !gate, (files) => {
    void addFiles(files);
  });
  // The assistant's name and role for an answer still being written, from its last answer.
  const assistant = state.messages.findLast((m) => m.sender.kind === 'ai_agent')?.sender;
  const person = canAskPerson ? (
    <Button
      variant="outline"
      size={compact ? 'icon' : 'sm'}
      className={
        compact
          ? 'size-11 shrink-0 rounded-full'
          : 'mb-2 h-auto min-h-9 rounded-full whitespace-normal py-1.5 text-start shadow-sm'
      }
      aria-label={compact ? t('talkToPerson') : undefined}
      title={compact ? t('talkToPerson') : undefined}
      onClick={() => void handoff()}
    >
      <UserRoundIcon className="size-4" aria-hidden="true" />
      {compact ? null : t('talkToPerson')}
    </Button>
  ) : null;
  const fine = (
    <FinePrint url={config.privacyPolicyUrl} branded={config.brand.showBranding !== false} />
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section
        aria-label={config.brand.name}
        className={`relative flex h-full flex-col ${centered ? 'mx-auto w-full max-w-2xl' : ''}`}
        data-conversation-id={conversation?.id ?? ''}
        data-mode={props.mode}
        data-header={props.headerStyle ?? 'brand'}
        {...drop.handlers}
      >
        <Header
          brand={config.brand}
          locale={locale}
          onLocale={props.onLocale}
          ai={!conversation || conversation.responder === 'ai'}
          menu={{
            id: moreId,
            open: more,
            onToggle: () => setMore((open) => !open),
            onClose: (focus) => {
              setMore(false);
              if (focus) document.getElementById('hv-more')?.focus();
            },
            items: (
              <>
                {/* Memory lives here, not in the header, so the header keeps to a few controls. */}
                {memoryShown ? (
                  <li>
                    <Button
                      id="hv-memory-open"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      aria-pressed={view === 'memory'}
                      onClick={() => (view === 'memory' ? back('hv-more') : show('memory'))}
                    >
                      <BrainIcon className="size-4" aria-hidden="true" />
                      {t('memory.open')}
                    </Button>
                  </li>
                ) : null}
                {hasOthers ? (
                  <li>
                    <Button
                      id="hv-conversations-open"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => show('conversations')}
                    >
                      <MessagesSquareIcon className="size-4" aria-hidden="true" />
                      {t('surface.conversations.title')}
                    </Button>
                  </li>
                ) : null}
                <li>
                  <Button
                    id="hv-settings-open"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => show('settings')}
                  >
                    <SettingsIcon className="size-4" aria-hidden="true" />
                    {t('surface.settings.title')}
                  </Button>
                </li>
                {/* On a short screen the small print lives here, so the conversation keeps its room. */}
                {short ? <li className="border-t border-border px-2 pt-1 pb-1.5">{fine}</li> : null}
              </>
            ),
          }}
          expand={props.expand ?? null}
          onClose={props.onClose}
        >
          {conversation?.ticket ? (
            <p className="text-xs" data-testid="header-ticket">
              <TicketLine ticket={conversation.ticket} />
            </p>
          ) : null}
          {statusInHeader ? (
            <StatusLine availability={config.availability} locale={locale} compact tone="inherit" />
          ) : null}
        </Header>
        {banner ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface-sunken px-4 py-2 [@media(max-height:26rem)]:py-1">
            <p
              role="status"
              className="min-w-0 flex-1 basis-40 text-sm text-text [@media(max-height:26rem)]:text-xs"
              data-testid="status-banner"
            >
              {banner}
            </p>
            {/* Without a rating to ask, the banner is where to open the conversation again. */}
            {resolved && !config.features.csat && available ? <Reopen onReopen={reopen} /> : null}
            {canGoBack ? <BackToAssistant onCancel={props.onCancelHandoff} /> : null}
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
            <WifiOffIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1">
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
        <Suspense fallback={<PanelLoading />}>
          {view === 'memory' ? (
            <MemoryPanel controls={memory} onBack={() => back('hv-more')} />
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
        </Suspense>
        <ThreadPrimitive.Root
          className={view === 'chat' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        >
          <SeenReporter
            visible={props.visible && view === 'chat'}
            onSeen={props.onSeen}
            latest={state.latestSequence}
          />
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Focusable so keyboard users can scroll it even when no card has a control. */}
            <ThreadPrimitive.Viewport
              className="hv-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4"
              // The home screen reads from the top (the greeting, who is online); a conversation
              // keeps to its newest message.
              autoScroll={!empty}
              tabIndex={0}
              aria-label={t('title')}
              data-testid="thread"
            >
              {/* The brand's words about its assistant open every conversation (U09). */}
              {empty ? null : (
                <>
                  <p
                    className="mb-3 text-center text-xs text-text-muted"
                    data-testid="ai-disclosure"
                  >
                    {copy.aiDisclosure}
                  </p>
                  {/* Which pages the website notes, and how to stop it: before anything is written. */}
                  <VisitorNotice
                    text={props.visitorNotice}
                    className="mb-3 text-center text-xs text-text-muted"
                  />
                </>
              )}
              {state.olderCursor ? (
                <div className="mb-3 flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    busy={state.loadingOlder}
                    onClick={() => void props.onLoadOlder()}
                    data-testid="older"
                  >
                    {state.loadingOlder ? t('surface.history.loading') : t('surface.history.older')}
                  </Button>
                </div>
              ) : null}
              {gate ? (
                <Suspense fallback={<PanelLoading />}>
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
                </Suspense>
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
                  recent={others[0] ?? null}
                  onOpenRecent={(id) => void props.onOpenConversation(id)}
                  onAsk={(question) => void send(question)}
                  team={config.team}
                  disclosure={copy.aiDisclosure}
                  notice={props.visitorNotice}
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
                      t(
                        choice === 'granted' ? 'memory.switch.turnedOn' : 'memory.consent.declined',
                      ),
                    );
                  }}
                />
              ) : null}
              <ul className="flex flex-col gap-3" aria-label={t('title')}>
                <ThreadPrimitive.Messages>
                  {({ message }) => {
                    const item = message as unknown as ThreadMessageLike;
                    const card = (item.metadata?.custom as Partial<Custom> | undefined)?.card;
                    // Only a card follows the shop's state; other bubbles are left as they are.
                    return (
                      <Bubble message={item} ctx={ctx} commerce={card ? props.commerce : null} />
                    );
                  }}
                </ThreadPrimitive.Messages>
                {state.drafts.map((draft) => (
                  <DraftBubble
                    key={draft.draftId}
                    draft={draft}
                    name={assistant?.displayName ?? ''}
                    role={assistant?.roleLabel ?? ''}
                    logoUrl={logoUrl}
                  />
                ))}
                {replying && state.drafts.length === 0 ? (
                  <Thinking run={working ? state.run : null} logoUrl={logoUrl} />
                ) : null}
              </ul>
            </ThreadPrimitive.Viewport>
            {empty ? null : <JumpToLatest unread={state.unread} smooth={!props.display.reduced} />}
          </div>
          <div className="bg-bg px-3 pt-1 pb-[max(0.75rem,var(--hv-safe-bottom,env(safe-area-inset-bottom)))] [@media(max-height:26rem)]:pb-[max(0.25rem,var(--hv-safe-bottom,env(safe-area-inset-bottom)))]">
            {available ? <ShopBar commerce={props.commerce} locale={locale} /> : null}
            {state.error && available ? (
              <p
                role="status"
                className="mb-2 flex items-start gap-2 rounded-lg bg-danger-subtle px-3 py-2 text-xs text-text"
                data-testid="chat-problem"
              >
                <span className="min-w-0 flex-1">{t('ui.problem')}</span>
                {props.onReconnect ? (
                  <Button variant="link" className="h-auto text-xs" onClick={props.onReconnect}>
                    {t('ui.retry')}
                  </Button>
                ) : null}
                {props.onDismissError ? (
                  <Button variant="link" className="h-auto text-xs" onClick={props.onDismissError}>
                    {t('ui.dismiss')}
                  </Button>
                ) : null}
              </p>
            ) : null}
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
                {compact ? null : person}
                <LanguageQuestion
                  state={props.language.state}
                  onChoose={props.language.choose}
                  onDismiss={props.language.dismiss}
                />
                <StaffTypingLine name={props.staffTyping} />
                <div className="flex items-end gap-2">
                  {compact ? person : null}
                  <div className="min-w-0 flex-1">
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
                        maxMb,
                      }}
                      onFiles={(files) => void addFiles(files)}
                      onRemoveChip={(id) =>
                        setChips((current) => current.filter((c) => c.id !== id))
                      }
                      onSendFiles={sendFiles}
                      locale={locale}
                      prefill={prefill}
                      onPrefilled={(at) => {
                        prefillUsed.current = at;
                      }}
                      onStop={working ? props.onStop : undefined}
                    />
                  </div>
                </div>
              </>
            )}
            {short ? null : fine}
          </div>
        </ThreadPrimitive.Root>
        {drop.over ? (
          <div
            className="hv-fade pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-surface/95 p-4 text-center text-sm font-medium text-text"
            data-testid="drop-zone"
          >
            {t('ui.drop')}
          </div>
        ) : null}
      </section>
    </AssistantRuntimeProvider>
  );
}
