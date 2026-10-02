import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import type { OutgoingMessage } from '@hamnivo/client';
import type {
  Message,
  ReplyLanguage,
  WidgetLanguageState,
  WidgetSession,
} from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ParticipantBadge, type ParticipantKind } from '@hamnivo/ui/components/participant-badge';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommerceCard, type Part } from '../commerce/Cards.js';
import { ShopBar } from '../commerce/ShopBar.js';
import type { Commerce } from '../commerce/useCommerce.js';
import { LANGUAGE_NAMES, LOCALES, type Locale, REPLY_LANGUAGE_NAMES } from '../i18n.js';
import { renderMarkdown } from '../markdown.js';
import type { ChatState } from '../useChat.js';
import type { MemoryControls } from '../useMemory.js';
import { BidiText, directionOf } from './BidiText.js';
import { MemoryConsent } from './MemoryConsent.js';
import { MemoryPanel, useSlotLabel } from './MemoryPanel.js';

interface Source {
  id: string;
  title: string;
  url: string | null;
  excerpt: string | null;
}

interface Custom {
  kind: ParticipantKind;
  name: string;
  role: string;
  state: 'accepted' | OutgoingMessage['state'];
  clientMessageId?: string;
  /** Knowledge an AI answer cites, numbered as in its text (G06). */
  sources?: Source[];
  /** A card (quote, receipt…) from Hamnivo's records, rendered instead of text. */
  card?: Part;
  /** Memories an AI answer used (G19): shown as memories, never as something said now. */
  memories?: string[];
}

const textOf = (m: Message) =>
  m.parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'card' ? p.fallbackText : ''))
    .join('\n')
    .trim();

const cardOf = (m: Message): Part | undefined => m.parts.find((p): p is Part => p.type === 'card');
const memoriesOf = (m: Message): string[] =>
  m.parts.flatMap((p) => (p.type === 'memory' ? [p.key] : []));

const sourcesOf = (m: Message): Source[] =>
  m.parts.flatMap((p) =>
    p.type === 'source' ? [{ id: p.sourceId, title: p.title, url: p.url, excerpt: p.excerpt }] : [],
  );

function toThread(
  messages: Message[],
  pending: readonly OutgoingMessage[],
  you: string,
): ThreadMessageLike[] {
  const confirmed = messages.map((m): ThreadMessageLike => {
    const kind: ParticipantKind =
      m.sender.kind === 'ai_agent' ? 'ai_primary' : (m.sender.kind as ParticipantKind);
    return {
      id: m.id,
      role:
        m.sender.kind === 'customer' ? 'user' : m.sender.kind === 'system' ? 'system' : 'assistant',
      content: [{ type: 'text', text: textOf(m) }],
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
        } satisfies Custom,
      },
    }),
  );
  return [...confirmed, ...unsent];
}

function Bubble({
  message,
  onRetry,
  commerce,
  locale,
  onHelp,
  onOpenMemory,
}: {
  message: ThreadMessageLike;
  onRetry: (id: string) => void;
  commerce: Commerce;
  locale: Locale;
  onHelp: (() => void) | undefined;
  onOpenMemory: () => void;
}) {
  const { t } = useTranslation();
  const slotLabel = useSlotLabel();
  const custom = (message.metadata?.custom ?? {}) as unknown as Partial<Custom>;
  if (custom.card) {
    return (
      <li className="flex flex-col items-start gap-1" data-sender="system">
        <CommerceCard part={custom.card} commerce={commerce} locale={locale} onHelp={onHelp} />
      </li>
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
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.map((p) => ('text' in p ? p.text : '')).join('');
  return (
    <li
      className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}
      data-sender={custom.kind}
      data-state={custom.state}
    >
      {!mine && custom.kind !== 'system' ? (
        <ParticipantBadge
          kind={custom.kind}
          name={custom.name ?? ''}
          roleLabel={custom.role ?? ''}
        />
      ) : null}
      {mine || custom.kind === 'system' ? (
        <div
          dir={directionOf(text)}
          data-testid="message-text"
          className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[15px] leading-relaxed ${
            mine ? 'bg-primary text-primary-foreground' : 'bg-transparent text-text-muted text-sm'
          }`}
        >
          <BidiText text={text} />
        </div>
      ) : (
        <div
          dir={directionOf(text)}
          data-testid="message-text"
          className="hv-markdown max-w-[85%] break-words rounded-2xl border border-border bg-surface px-3 py-2 text-[15px] leading-relaxed text-text"
          // Sanitized by renderMarkdown: a short allow-list of tags and http(s) links only.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
        />
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
          <Button variant="link" className="h-auto text-xs" onClick={onOpenMemory}>
            {t('memory.see')}
          </Button>
        </p>
      ) : null}
      {mine && custom.state !== 'accepted' ? (
        <p
          className="flex items-center gap-2 text-xs text-text-muted"
          role={custom.state === 'failed' ? 'alert' : undefined}
        >
          {custom.state === 'failed' ? (
            <>
              <span className="text-danger">{t('notSent')}</span>
              <Button
                variant="link"
                className="h-auto text-xs"
                onClick={() => custom.clientMessageId && onRetry(custom.clientMessageId)}
              >
                {t('retry')}
              </Button>
            </>
          ) : (
            <span>{t('sending')}</span>
          )}
        </p>
      ) : null}
    </li>
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

/**
 * The message box (U08). Enter sends and Shift+Enter starts a new line, but an Enter that
 * confirms an input method composition (Hindi, Urdu, Arabic or Chinese keyboards) never sends:
 * browsers flag it with isComposing, Safari only with key code 229 after the composition ends.
 * The box follows the direction of what is typed, so Urdu typed in the English interface reads
 * right to left.
 */
function Composer({ label, send }: { label: string; send: string }) {
  const text = useAuiState((s) => s.composer.text);
  const composing = useRef(false);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  return (
    <ComposerPrimitive.Root className="flex items-end gap-2">
      <ComposerPrimitive.Input
        aria-label={label}
        placeholder={label}
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
        className="min-h-11 flex-1 resize-none rounded-xl border border-input bg-bg px-3 py-2.5 text-base text-text"
      />
      <ComposerPrimitive.Send asChild>
        <Button className="min-h-11">{send}</Button>
      </ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  );
}

export function Chat(props: {
  session: WidgetSession;
  state: ChatState;
  commerce: Commerce;
  pending: readonly OutgoingMessage[];
  locale: Locale;
  onLocale: (locale: Locale) => void;
  onSend: (text: string) => Promise<void>;
  onRetry: (clientMessageId: string) => void;
  onHandoff: () => Promise<void>;
  onClose?: () => void;
  language: {
    state: WidgetLanguageState | null;
    choose: (language: ReplyLanguage) => Promise<void>;
    dismiss: () => Promise<void>;
  };
  memory: MemoryControls;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { session, state, locale, memory } = props;
  const [view, setView] = useState<'chat' | 'memory'>('chat');
  const [askLater, setAskLater] = useState(false);
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
  const openMemory = () => {
    setView('memory');
    void memory.reload();
  };
  const closeMemory = () => {
    setView('chat');
    requestAnimationFrame(() => document.getElementById('hv-memory-open')?.focus());
  };
  const copy = session.config.copy[locale] ?? session.config.copy.en;
  const conversation = state.conversation;
  const messages = useMemo(
    () => toThread(state.messages, props.pending, t('you')),
    [state.messages, props.pending, t],
  );
  const canAskPerson =
    conversation?.responder !== 'person' && conversation?.status !== 'waiting_for_person';
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
        announce(`${m.sender.displayName}: ${textOf(m)}`);
    }
  }, [announce, state.messages]);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (m) => m,
    isRunning: aiWriting,
    onNew: async (append) => {
      const text = append.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
      await props.onSend(text);
    },
  });

  const banner =
    conversation?.status === 'waiting_for_person'
      ? (state.handoffNotice ?? t('waitingForPerson'))
      : conversation?.status === 'with_person'
        ? t('withPerson')
        : conversation?.status === 'resolved'
          ? t('resolved')
          : null;
  const connection =
    state.connection === 'offline'
      ? t('offline')
      : state.connection === 'reconnecting'
        ? t('reconnecting')
        : null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section
        aria-label={session.config.brand.name}
        className="flex h-full flex-col"
        data-conversation-id={conversation?.id ?? ''}
      >
        <header className="flex items-start gap-3 border-b border-border bg-surface px-4 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-text">
              {session.config.brand.name}
            </h1>
            <p className="text-sm text-text-muted" data-testid="ai-disclosure">
              {copy.aiDisclosure}
            </p>
          </div>
          {memoryShown ? (
            <Button
              id="hv-memory-open"
              variant="ghost"
              className="h-10 px-2 text-sm"
              aria-pressed={view === 'memory'}
              onClick={() => (view === 'memory' ? closeMemory() : openMemory())}
            >
              {t('memory.open')}
            </Button>
          ) : null}
          <label className="sr-only" htmlFor="hv-locale">
            {t('language')}
          </label>
          <select
            id="hv-locale"
            className="h-10 rounded-md border border-input bg-surface px-2 text-sm"
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
        </header>
        {banner ? (
          <p
            role="status"
            className="border-b border-border bg-surface-sunken px-4 py-2 text-sm text-text"
            data-testid="status-banner"
          >
            {banner}
          </p>
        ) : null}
        {connection ? (
          <p
            role="status"
            className="bg-warning-subtle px-4 py-1.5 text-xs text-text"
            data-testid="connection"
          >
            {connection}
          </p>
        ) : null}
        {view === 'memory' ? <MemoryPanel controls={memory} onBack={closeMemory} /> : null}
        <ThreadPrimitive.Root
          className={view === 'memory' ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
        >
          <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {state.messages.length === 0 && props.pending.length === 0 ? (
              <p
                className="mb-4 rounded-2xl border border-border bg-surface px-3 py-2 text-[15px] text-text"
                data-testid="greeting"
              >
                {copy.greeting}
              </p>
            ) : null}
            {askConsent && remembered ? (
              <MemoryConsent
                maxRetentionDays={remembered.maxRetentionDays}
                privacyPolicyUrl={session.config.privacyPolicyUrl}
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
                  <Bubble
                    message={message as unknown as ThreadMessageLike}
                    onRetry={props.onRetry}
                    commerce={props.commerce}
                    locale={locale}
                    onHelp={canAskPerson ? () => void props.onHandoff() : undefined}
                    onOpenMemory={openMemory}
                  />
                )}
              </ThreadPrimitive.Messages>
            </ul>
          </ThreadPrimitive.Viewport>
          <div className="border-t border-border bg-surface px-3 pb-3 pt-2">
            <ShopBar commerce={props.commerce} locale={locale} />
            {canAskPerson ? (
              <Button
                variant="link"
                className="mb-1 h-auto text-sm"
                onClick={() => void props.onHandoff()}
              >
                {t('talkToPerson')}
              </Button>
            ) : null}
            <LanguageQuestion
              state={props.language.state}
              onChoose={props.language.choose}
              onDismiss={props.language.dismiss}
            />
            <Composer label={t('placeholder')} send={t('send')} />
          </div>
        </ThreadPrimitive.Root>
      </section>
    </AssistantRuntimeProvider>
  );
}
