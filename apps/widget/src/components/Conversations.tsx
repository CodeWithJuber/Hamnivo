import type { CustomerConversation } from '@hamnivo/contracts';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { BidiText } from './BidiText.js';
import { SubHeader } from './shell/SubHeader.js';
import { TicketLine } from './TicketLine.js';

/**
 * The visitor's conversations (W18). A signed-in customer sees the same list on every device; an
 * anonymous visitor only what this browser started. A ticket shows its reference and where it
 * stands (H19), which also says whether it is closed.
 */
export function Conversations(props: {
  conversations: readonly CustomerConversation[];
  current: string | null;
  locale: string;
  onOpen: (conversationId: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const when = new Intl.DateTimeFormat(props.locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      data-testid="conversations"
    >
      <SubHeader
        title={t('surface.conversations.title')}
        titleId={`${id}-title`}
        back={t('surface.conversations.back')}
        onBack={props.onBack}
      />
      <ul className="flex flex-col gap-2">
        {props.conversations.map((conversation) => {
          const current = conversation.id === props.current;
          return (
            <li key={conversation.id}>
              <button
                type="button"
                className="flex w-full flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2.5 text-start text-sm shadow-sm hover:bg-surface-sunken focus-visible:outline-2"
                aria-current={current ? 'true' : undefined}
                onClick={() => props.onOpen(conversation.id)}
                data-testid="conversation-item"
              >
                <span className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <time dateTime={conversation.updatedAt}>
                    {when.format(new Date(conversation.updatedAt))}
                  </time>
                  {current ? <span>· {t('surface.conversations.current')}</span> : null}
                  {conversation.ticket ? (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      · <TicketLine ticket={conversation.ticket} />
                    </span>
                  ) : conversation.status === 'resolved' ? (
                    <span>· {t('surface.conversations.closed')}</span>
                  ) : null}
                  {conversation.unreadCount > 0 ? (
                    <span className="rounded-full bg-primary px-2 text-primary-foreground">
                      {t('surface.conversations.unread', { count: conversation.unreadCount })}
                    </span>
                  ) : null}
                </span>
                <span className="line-clamp-2 break-words text-text">
                  {conversation.lastMessagePreview ? (
                    <BidiText text={conversation.lastMessagePreview} />
                  ) : (
                    t('surface.conversations.empty')
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
