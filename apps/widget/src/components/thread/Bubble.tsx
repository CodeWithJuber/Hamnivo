import type { ThreadMessageLike } from '@assistant-ui/react';
import type { HamnivoClient } from '@hamnivo/client';
import type { ReactionEmoji } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { isAiParticipant } from '@hamnivo/ui/components/participant-badge';
import { PaperclipIcon } from 'lucide-react';
import { lazy, memo, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Commerce } from '../../commerce/useCommerce.js';
import type { Locale } from '../../i18n.js';
import { useSlotLabel } from '../../memory-slots.js';
import { BidiText, directionOf } from '../BidiText.js';
import { DeleteMessage, EMOJI_NAMES } from '../MessageActions.js';
import { Contact, Files, fileSize, Place, Unknown } from '../Parts.js';
import { Avatar } from './Avatar.js';
import { Delivery, SentAt } from './Delivery.js';
import { dayLabel } from './grouping.js';
import { Markdown } from './Markdown.js';
import type { Custom } from './model.js';
import { Sources } from './Sources.js';
import { Toolbar } from './Toolbar.js';

// Cards (shop, approvals, choices) load when a conversation first shows one.
const CommerceCard = lazy(() =>
  import('../../commerce/Cards.js').then((module) => ({ default: module.CommerceCard })),
);

/** What every bubble shares. It keeps its identity between renders, so bubbles are not redrawn. */
export interface BubbleContext {
  client: HamnivoClient;
  conversationId: string | null;
  locale: Locale;
  offline: boolean;
  /** How long after sending a message can be deleted; 0 when it can't (W23). */
  deleteWindowMs: number;
  /** Chat isn't available to this visitor (H20): messages can be read, not answered or reacted to. */
  readOnly: boolean;
  /** The brand's logo, shown as its assistant's picture. */
  logoUrl: string | null;
  /** Messages written after this moment (ms) arrive with a small movement; history does not. */
  freshAfter: number;
  /** Whether "talk to a person" can be offered from a card. */
  canAskPerson: boolean;
  onRetry: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onHelp: () => void;
  onOpenMemory: () => void;
  onDelete: (messageId: string) => Promise<void>;
  onReact: (messageId: string, emoji: ReactionEmoji) => Promise<void>;
  /** Sends a suggested question, or the answer chosen on a card, as the visitor's own message. */
  onAsk: (text: string) => void;
}

const incomingBubble =
  'max-w-[92%] break-words rounded-xl border border-border bg-surface px-3.5 py-2 text-[0.9375rem] leading-relaxed text-text shadow-sm';

/** The line where a day starts. */
function DayLine({ day, locale }: { day: string; locale: string }) {
  const { t } = useTranslation();
  return (
    <li
      className="flex items-center gap-3 py-1 text-xs font-medium text-text-muted"
      data-testid="day"
    >
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      {dayLabel(day, new Date(), locale, {
        today: t('ui.today'),
        yesterday: t('ui.yesterday'),
      })}
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </li>
  );
}

/** One message of the conversation, with what belongs to it: who wrote it, files, sources, actions. */
export const Bubble = memo(function Bubble({
  message,
  ctx,
  commerce,
}: {
  message: ThreadMessageLike;
  ctx: BubbleContext;
  /** The shop's state, given only to a message that shows a card; it changes often. */
  commerce: Commerce | null;
}) {
  const { t } = useTranslation();
  const slotLabel = useSlotLabel();
  const [cited, setCited] = useState<{ number: number; at: number } | null>(null);
  const [showTime, setShowTime] = useState(false);
  const custom = (message.metadata?.custom ?? {}) as unknown as Partial<Custom>;
  if (!custom.kind) return null;
  const day = custom.day ? <DayLine day={custom.day} locale={ctx.locale} /> : null;
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
  const fresh =
    custom.state !== 'accepted' ||
    (custom.createdAt !== undefined && Date.parse(custom.createdAt) > ctx.freshAfter);
  const enter = fresh ? 'hv-enter' : '';
  if (custom.card && commerce) {
    const { card } = custom;
    return (
      <>
        {day}
        {divider}
        <li className={`flex flex-col items-start gap-1 ${enter}`} data-sender="system">
          <Suspense
            fallback={
              <p dir="auto" className="text-sm text-text-muted">
                {card.fallbackText}
              </p>
            }
          >
            <CommerceCard
              part={card}
              commerce={commerce}
              locale={ctx.locale}
              onHelp={ctx.canAskPerson ? ctx.onHelp : undefined}
              onChoose={ctx.readOnly ? undefined : ctx.onAsk}
            />
          </Suspense>
        </li>
      </>
    );
  }
  const mine = message.role === 'user';
  // A reaction whose message is not on screen keeps a line of its own.
  if (custom.reaction) {
    return (
      <>
        {day}
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
      </>
    );
  }
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.map((p) => ('text' in p ? p.text : '')).join('');
  const system = custom.kind === 'system';
  const incoming = !mine && !system;
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
    incoming &&
    !ctx.readOnly &&
    !custom.deleted &&
    messageId !== undefined &&
    (custom.kind === 'ai_primary' || custom.kind === 'human_agent');
  const sources = custom.sources ?? [];
  const given = custom.reactions ?? [];
  // On devices with a pointer the actions of older replies wait for the pointer or the keyboard.
  const quiet = custom.latest
    ? ''
    : '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:group-focus-within/message:opacity-100';
  return (
    <>
      {day}
      {divider}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a tap only shows the time, which focus inside the message shows too and screen readers always read */}
      <li
        className={`group/message flex gap-2 ${mine ? 'flex-row-reverse' : ''} ${
          custom.first === false && !custom.day && !custom.firstUnread ? '-mt-1.5' : ''
        } ${enter}`}
        data-sender={custom.kind}
        data-state={custom.state}
        data-delivery={custom.delivery ?? undefined}
        data-show-time={showTime || undefined}
        onClick={(event) => {
          // Links and buttons in the message do their own thing.
          if ((event.target as HTMLElement).closest('a, button, input, textarea, select')) return;
          if (!custom.last) setShowTime((shown) => !shown);
        }}
      >
        {incoming ? (
          <span className="w-8 shrink-0 max-[20rem]:hidden" aria-hidden="true">
            {custom.first ? (
              <Avatar
                kind={custom.kind}
                name={custom.name ?? ''}
                url={custom.avatarUrl}
                logoUrl={ctx.logoUrl}
              />
            ) : null}
          </span>
        ) : null}
        <div
          className={`flex min-w-0 flex-1 flex-col gap-1 ${
            mine ? 'items-end' : system ? 'items-center' : 'items-start'
          }`}
        >
          {incoming ? (
            // Who is writing is said in words on every message; only the first of a turn shows it.
            <p
              className={
                custom.first ? 'flex flex-wrap items-baseline gap-x-1.5 text-xs' : 'sr-only'
              }
            >
              <span className="font-semibold text-text">{custom.name}</span>
              <span
                className={
                  isAiParticipant(custom.kind) ? 'font-medium text-info' : 'text-text-muted'
                }
              >
                {custom.role}
              </span>
            </p>
          ) : null}
          {custom.deleted ? (
            <p
              className="max-w-[85%] rounded-xl border border-dashed border-border px-3 py-2 text-sm italic text-text-muted"
              data-testid="message-deleted"
            >
              {t('surface.parts.deleted')}
            </p>
          ) : !text ? null : mine ? (
            <div
              dir={directionOf(text)}
              data-testid="message-text"
              className={`max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-primary px-3.5 py-2 text-[0.9375rem] leading-relaxed text-primary-foreground shadow-sm ${
                custom.last ? 'rounded-ee-sm' : ''
              }`}
            >
              <BidiText text={text} />
            </div>
          ) : system ? (
            <div
              dir={directionOf(text)}
              data-testid="message-text"
              className="max-w-[90%] whitespace-pre-wrap break-words text-center text-xs text-text-muted"
            >
              <BidiText text={text} />
            </div>
          ) : (
            <Markdown
              text={text}
              sources={sources.length}
              testId="message-text"
              className={`${incomingBubble} ${custom.first ? 'rounded-ss-sm' : ''}`}
              onCite={(number) => setCited({ number, at: Date.now() })}
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
              <Unknown
                key={`unknown-${part.originalType}-${part.fallbackText ?? ''}`}
                part={part}
              />
            ) : null,
          )}
          {custom.notes?.map((note) => (
            <p key={note} dir="auto" className="max-w-[92%] text-sm text-text-muted">
              <BidiText text={note} />
            </p>
          ))}
          {sources.length ? <Sources sources={sources} focused={cited} /> : null}
          {custom.memories?.length ? (
            <p className="max-w-[92%] text-xs text-text-muted" data-testid="memory-note">
              {t('memory.used', {
                labels: [...new Set(custom.memories)].map(slotLabel).join(', '),
              })}{' '}
              <Button variant="link" className="h-auto text-xs" onClick={ctx.onOpenMemory}>
                {t('memory.see')}
              </Button>
            </p>
          ) : null}
          {custom.suggestions?.length && !ctx.readOnly ? (
            <ul className="flex max-w-full flex-wrap gap-2 pt-1" data-testid="follow-ups">
              {custom.suggestions.map((question) => (
                <li key={question} className="max-w-full">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-9 max-w-full rounded-full whitespace-normal py-1.5 text-start"
                    dir="auto"
                    onClick={() => ctx.onAsk(question)}
                  >
                    {question}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {mine ? (
            <div className="flex flex-wrap items-center justify-end gap-x-2 text-xs text-text-muted">
              {custom.state === 'accepted' ? (
                <SentAt at={custom.createdAt} locale={ctx.locale} quiet={!custom.last} />
              ) : null}
              <Delivery
                custom={custom}
                offline={ctx.offline}
                readOnly={ctx.readOnly}
                onRetry={ctx.onRetry}
                onEdit={ctx.onEdit}
                onRemove={ctx.onRemove}
              />
            </div>
          ) : null}
          {canDelete && messageId ? (
            <DeleteMessage onDelete={() => ctx.onDelete(messageId)} />
          ) : null}
          {incoming ? (
            <div className="flex flex-wrap items-start gap-x-1.5 text-xs text-text-muted">
              <span className="leading-8">
                <SentAt at={custom.createdAt} locale={ctx.locale} quiet={!custom.last} />
              </span>
              {given.map((emoji) => (
                <span
                  key={emoji}
                  className="hv-pop mt-1 inline-flex h-6 items-center rounded-full border border-border bg-surface px-1.5 text-sm"
                  data-testid="reaction"
                >
                  <span aria-hidden="true">{emoji}</span>
                  <span className="sr-only">
                    {t('surface.actions.reacted', {
                      emoji: t(`surface.actions.emoji.${EMOJI_NAMES[emoji]}`),
                    })}
                  </span>
                </span>
              ))}
              {custom.deleted || (!text && !canReact) ? null : (
                <div className={quiet}>
                  <Toolbar
                    text={text}
                    canReact={canReact}
                    given={given}
                    onReact={(emoji) =>
                      messageId ? ctx.onReact(messageId, emoji) : Promise.resolve()
                    }
                  />
                </div>
              )}
            </div>
          ) : null}
        </div>
      </li>
    </>
  );
});
