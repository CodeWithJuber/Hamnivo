import { Button } from '@hamnivo/ui/components/button';
import { LaneLabel, LaneSurface } from '@hamnivo/ui/components/lane';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ParticipantAvatar, type ParticipantKind } from '@hamnivo/ui/components/participant-badge';
import { Skeleton } from '@hamnivo/ui/components/skeleton';
import { cn } from '@hamnivo/ui/lib/utils';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { FileTextIcon, LanguagesIcon, LinkIcon, LockIcon, PaperclipIcon } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError, ErrorPanel } from '../../components/States';
import { api } from '../../lib/api';
import type {
  InboxDetail,
  InboxMessage,
  InboxMessagePage,
  MessageTranslation,
} from '../../lib/inbox';
import { withReauth } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import { dayLabel, languageName, timeOfDay } from './parts';

const AVATAR: Record<InboxMessage['sender']['kind'], ParticipantKind> = {
  customer: 'customer',
  human_agent: 'human_agent',
  ai_agent: 'ai_primary',
  ai_specialist: 'ai_specialist',
  guest: 'guest',
  external_agent: 'external_agent',
  system: 'system',
};

function textOf(message: InboxMessage): string {
  return message.parts
    .map((part) =>
      part.type === 'text' || part.type === 'notice'
        ? part.text
        : part.type === 'unknown'
          ? (part.fallbackText ?? '')
          : '',
    )
    .filter(Boolean)
    .join('\n');
}

function roleOf(t: TFunction, message: InboxMessage): string {
  switch (message.sender.kind) {
    case 'customer':
      return t('inbox.roles.customer');
    case 'human_agent':
      return message.mine ? t('inbox.roles.you') : t('inbox.roles.staff');
    case 'ai_agent':
      return t('inbox.roles.ai');
    case 'ai_specialist':
    case 'external_agent':
      return t('inbox.roles.specialist');
    case 'guest':
      return t('inbox.roles.guest');
    default:
      return t('inbox.roles.system');
  }
}

function Translation({
  conversationId,
  message,
}: {
  conversationId: string;
  message: InboxMessage;
}) {
  const { t, i18n } = useTranslation();
  const { tenantId } = useTenant();
  const [result, setResult] = useState<MessageTranslation | null>(null);
  const [shown, setShown] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const target = (i18n.resolvedLanguage ?? i18n.language ?? 'en').split('-')[0] ?? 'en';
  const translate = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await withReauth(() =>
          api<MessageTranslation>(
            `/v1/inbox/conversations/${conversationId}/messages/${message.id}/translation`,
            { method: 'POST', tenant: tenantId, body: { targetLanguage: target } },
          ),
        ),
      );
      setShown(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  if (!result) {
    return (
      <div className="flex flex-col gap-1">
        <Button
          variant="link"
          size="sm"
          className="self-start text-xs"
          busy={busy}
          onClick={() => void translate()}
          data-testid="translate"
        >
          <LanguagesIcon className="size-3.5" aria-hidden="true" />
          {t('inbox.translation.translate', { language: languageName(target) ?? target })}
        </Button>
        {error ? (
          <>
            <p className="text-xs text-text-secondary">{t('inbox.translation.failed')}</p>
            <ActionError error={error} />
          </>
        ) : null}
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-dashed border-border bg-surface-muted p-2"
      data-testid="translation"
    >
      <p className="flex flex-wrap items-center gap-1 text-xs text-text-secondary">
        <LanguagesIcon className="size-3.5" aria-hidden="true" />
        {t('inbox.translation.label', {
          language: languageName(result.targetLanguage) ?? result.targetLanguage,
        })}
        <Button
          variant="link"
          size="sm"
          className="h-auto text-xs"
          aria-expanded={shown}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? t('inbox.translation.hide') : t('inbox.translation.show')}
        </Button>
      </p>
      {shown ? (
        <p className="text-sm whitespace-pre-wrap text-text">
          <bdi dir="auto">{result.text}</bdi>
        </p>
      ) : null}
    </div>
  );
}

function Sources({ message }: { message: InboxMessage }) {
  const { t } = useTranslation();
  const sources = message.parts.filter((part) => part.type === 'source');
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-text-secondary">{t('inbox.message.sources')}</p>
      <ol className="flex flex-col gap-1 text-xs">
        {sources.map((source) =>
          source.type === 'source' ? (
            <li key={source.sourceId} className="flex items-start gap-1">
              <LinkIcon className="mt-0.5 size-3 shrink-0 text-text-muted" aria-hidden="true" />
              {source.url ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-link underline"
                >
                  <bdi>{source.title}</bdi>
                </a>
              ) : (
                <bdi>{source.title}</bdi>
              )}
            </li>
          ) : null,
        )}
      </ol>
    </div>
  );
}

function Attachments({ message }: { message: InboxMessage }) {
  const { t } = useTranslation();
  const files = message.parts.filter((part) => part.type === 'attachment');
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {files.map((file) =>
        file.type === 'attachment' ? (
          <li key={file.uploadId} className="flex items-center gap-1">
            <PaperclipIcon className="size-3 text-text-muted" aria-hidden="true" />
            {file.url && file.status === 'available' ? (
              <a
                href={file.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-link underline"
              >
                <bdi>{file.name}</bdi>
              </a>
            ) : (
              <span>
                <bdi>{file.name}</bdi> · {t(`inbox.message.file.${file.status}`)}
              </span>
            )}
          </li>
        ) : null,
      )}
    </ul>
  );
}

function MessageItem({ detail, message }: { detail: InboxDetail; message: InboxMessage }) {
  const { t } = useTranslation();
  const text = textOf(message);
  if (message.system === 'activity') {
    return (
      <li className="flex justify-center px-4" data-kind="activity">
        <p className="rounded-full bg-surface-sunken px-3 py-1 text-center text-xs text-text-secondary">
          <bdi dir="auto">{text}</bdi> ·{' '}
          <time dateTime={message.createdAt}>{timeOfDay(message.createdAt)}</time>
        </p>
      </li>
    );
  }
  if (message.system === 'hamnivo_note') {
    return (
      <li className="px-4" data-kind="hamnivo-note">
        <LaneSurface lane="internal" className="flex flex-col gap-2 p-3">
          <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-text">
            <FileTextIcon className="size-3.5" aria-hidden="true" />
            {t('inbox.message.handoffSummary')}
            <span className="inline-flex items-center gap-1 font-normal text-text-secondary">
              <LockIcon className="size-3" aria-hidden="true" />
              {t('inbox.message.staffOnly')}
            </span>
            <time dateTime={message.createdAt} className="ms-auto font-normal text-text-secondary">
              {timeOfDay(message.createdAt)}
            </time>
          </p>
          <p className="text-sm whitespace-pre-wrap text-text">
            <bdi dir="auto">{text}</bdi>
          </p>
        </LaneSurface>
      </li>
    );
  }
  const internal = message.visibility === 'internal';
  const outgoing = message.sender.kind !== 'customer';
  return (
    <li
      className={cn('flex gap-3 px-4', outgoing ? 'flex-row' : 'flex-row')}
      data-kind={internal ? 'note' : 'message'}
      data-sender={message.sender.kind}
      data-testid="timeline-message"
    >
      <ParticipantAvatar kind={AVATAR[message.sender.kind]} name={message.sender.displayName} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <bdi className="font-medium text-text">{message.sender.displayName}</bdi>
          <span
            className={cn(
              'text-xs',
              message.sender.kind === 'ai_agent' ? 'font-medium text-info' : 'text-text-secondary',
            )}
          >
            {roleOf(t, message)}
          </span>
          <time dateTime={message.createdAt} className="text-xs text-text-secondary">
            {timeOfDay(message.createdAt)}
          </time>
        </p>
        {internal ? (
          <LaneSurface lane="internal" className="flex flex-col gap-2 p-3">
            <LaneLabel
              lane="internal"
              labels={{
                internal: {
                  title: t('inbox.lanes.internal'),
                  description: t('inbox.lanes.internalDescription'),
                },
              }}
            />
            <p className="text-sm whitespace-pre-wrap text-text">
              <bdi dir="auto">{text}</bdi>
            </p>
          </LaneSurface>
        ) : (
          <div
            className={cn(
              'flex w-fit max-w-full flex-col gap-2 rounded-lg px-3 py-2',
              message.sender.kind === 'customer'
                ? 'bg-surface-sunken'
                : 'border border-border bg-surface',
            )}
          >
            {text ? (
              <p className="text-sm whitespace-pre-wrap text-text">
                <bdi dir="auto">{text}</bdi>
              </p>
            ) : null}
            <Attachments message={message} />
            <Sources message={message} />
          </div>
        )}
        {message.sender.kind === 'customer' && text ? (
          <Translation conversationId={detail.id} message={message} />
        ) : null}
      </div>
    </li>
  );
}

/**
 * The conversation as staff see it: customer messages, replies, internal notes (marked with a lock
 * and a dashed border, never by colour alone), Hamnivo's handoff summaries and status lines.
 */
export function Timeline({
  detail,
  messages,
  query,
}: {
  detail: InboxDetail;
  messages: InboxMessage[];
  query: UseInfiniteQueryResult<InfiniteData<InboxMessagePage>>;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastId = useRef<string | null>(null);
  const newest = messages.at(-1);

  // Start at the latest message, and stay there as new ones arrive unless the person scrolled up.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !newest) return;
    const first = lastId.current === null;
    if (first || atBottom.current) {
      element.scrollTop = element.scrollHeight;
      if (window.matchMedia('(max-width: 63.99rem)').matches && first) {
        element.lastElementChild?.scrollIntoView({ block: 'end' });
      }
    }
  }, [newest]);

  useEffect(() => {
    if (!newest) return;
    if (
      lastId.current !== null &&
      lastId.current !== newest.id &&
      newest.sender.kind === 'customer'
    ) {
      announce(t('inbox.message.newFrom', { name: newest.sender.displayName }));
    }
    lastId.current = newest.id;
  }, [newest, announce, t]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  let lastDay = '';
  return (
    <section
      aria-label={t('inbox.timeline.label')}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="timeline"
    >
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 py-4 lg:overflow-y-auto">
        {query.hasNextPage ? (
          <div className="flex justify-center pb-3">
            <Button
              variant="secondary"
              size="sm"
              busy={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('inbox.timeline.older')}
            </Button>
          </div>
        ) : null}
        {query.error && query.data === undefined ? (
          <div className="px-4">
            <ErrorPanel
              error={query.error}
              onRetry={() => query.refetch()}
              retrying={query.isRefetching}
            />
          </div>
        ) : query.isPending ? (
          <div className="flex flex-col gap-3 px-4" aria-busy="true">
            <span className="sr-only">{t('inbox.timeline.loading')}</span>
            <Skeleton className="h-12 w-2/3" />
            <Skeleton className="h-12 w-1/2" />
          </div>
        ) : messages.length === 0 ? (
          <p className="px-4 text-sm text-text-secondary">{t('inbox.timeline.empty')}</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {messages.map((message) => {
              const day = new Date(message.createdAt).toDateString();
              const separator = day !== lastDay;
              lastDay = day;
              return (
                <Fragment key={message.id}>
                  {separator ? (
                    <li className="flex items-center gap-3 px-4" aria-hidden="false">
                      <span className="h-px flex-1 bg-border" />
                      <span className="text-xs text-text-secondary">
                        {dayLabel(message.createdAt)}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </li>
                  ) : null}
                  <MessageItem detail={detail} message={message} />
                </Fragment>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
