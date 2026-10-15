import { ConnectionBanner, EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { Checkbox } from '@hamnivo/ui/components/checkbox';
import { Input } from '@hamnivo/ui/components/input';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ParticipantAvatar } from '@hamnivo/ui/components/participant-badge';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { cn } from '@hamnivo/ui/lib/utils';
import { Link, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  InboxIcon,
  ListFilterIcon,
  LockIcon,
  MessagesSquareIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { useDocumentTitle } from '../../components/PageHeader';
import { Forbidden, ListSkeleton, QueryState } from '../../components/States';
import { DOCS } from '../../lib/docs';
import { formatNumber } from '../../lib/format';
import {
  CHANNELS,
  type InboxConversation,
  type InboxSearch,
  PRIORITIES,
  QUEUES,
  STATUSES,
  useInboxList,
  useInboxSearch,
  useOnline,
} from '../../lib/inbox';
import { useInboxStream } from '../../lib/inbox-live';
import { useBrandRefs } from '../../lib/names';
import { useTenant } from '../../lib/tenant';
import { BulkBar } from './BulkBar';
import { DesktopAlertsPrompt, InboxToolbar } from './InboxToolbar';
import {
  ChannelIcon,
  ConversationStatusBadge,
  languageName,
  OwnerBadge,
  PriorityBadge,
  SlaBadge,
  shortTime,
  TicketReference,
  TicketStateBadge,
} from './parts';
import { UrgentSection } from './UrgentSection';

/** The row to put focus back on after leaving a conversation (Esc or Back on a phone). */
let returnFocusTo: string | null = null;
export function returnToQueue(conversationId: string) {
  returnFocusTo = conversationId;
}

const PREVIEW_FROM = { customer: '', ai: 'ai', staff: 'staff', system: 'system' } as const;

function RowPreview({ conversation }: { conversation: InboxConversation }) {
  const { t } = useTranslation();
  const last = conversation.lastMessage;
  if (!last) return <p className="truncate text-sm text-text-muted">{t('inbox.row.noMessages')}</p>;
  const from = PREVIEW_FROM[last.from];
  // The preview is cut at its own end: English text on an Arabic page keeps its beginning.
  return (
    <p className="flex min-w-0 gap-1 text-sm text-text-secondary">
      {from ? <span className="shrink-0 font-medium">{t(`inbox.row.from.${from}`)}</span> : null}
      <bdi dir="auto" className="min-w-0 truncate">
        {last.preview}
      </bdi>
    </p>
  );
}

/** How many customer messages in a chat are unread: a number for the eye, a sentence for a screen reader. */
export function UnreadBadge({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand-strong px-1.5 text-xs font-semibold text-on-brand-strong"
      data-testid="unread-badge"
    >
      <span aria-hidden="true">{count > 99 ? '99+' : formatNumber(count)}</span>
      <span className="sr-only">{t('inboxAlerts.unread.row', { count })}</span>
    </span>
  );
}

function QueueRow({
  conversation,
  selected,
  active,
  checked,
  selectable,
  onToggle,
  onFocusRow,
}: {
  conversation: InboxConversation;
  selected: boolean;
  active: boolean;
  checked: boolean;
  selectable: boolean;
  onToggle: (id: string) => void;
  onFocusRow: (id: string) => void;
}) {
  const { t } = useTranslation();
  const language = languageName(conversation.customer.language);
  const unread = conversation.unreadCount > 0;
  return (
    <li
      className={cn(
        'relative flex items-start gap-2 border-b border-border px-3 py-3',
        selected ? 'bg-brand-subtle' : 'hover:bg-surface-sunken',
        selected &&
          'before:absolute before:inset-y-2 before:start-0 before:w-1 before:rounded-full before:bg-brand',
      )}
      data-conversation-id={conversation.id}
      data-selected={selected ? 'true' : undefined}
    >
      {selectable ? (
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggle(conversation.id)}
          tabIndex={-1}
          aria-label={t('inbox.bulk.select', { name: conversation.customer.displayName })}
          className="mt-2.5"
          data-testid="row-select"
        />
      ) : null}
      <Link
        to="/inbox/$conversationId"
        params={{ conversationId: conversation.id }}
        search={(prev: InboxSearch) => prev}
        tabIndex={active ? 0 : -1}
        onFocus={() => onFocusRow(conversation.id)}
        aria-current={selected ? 'page' : undefined}
        data-row-link=""
        data-testid="inbox-row"
        className="flex min-w-0 flex-1 items-start gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ParticipantAvatar kind="customer" name={conversation.customer.displayName} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={cn('truncate text-text', unread ? 'font-semibold' : 'font-medium')}
              data-unread={unread ? 'true' : undefined}
            >
              <bdi>{conversation.customer.displayName}</bdi>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {unread ? <UnreadBadge count={conversation.unreadCount} /> : null}
              <time dateTime={conversation.lastActivityAt} className="text-xs text-text-secondary">
                {shortTime(conversation.lastActivityAt)}
              </time>
            </span>
          </span>
          <RowPreview conversation={conversation} />
          <span className="flex flex-wrap items-center gap-1.5">
            {conversation.ticket ? (
              <>
                <TicketReference reference={conversation.ticket.reference} />
                <TicketStateBadge state={conversation.ticket.state} />
              </>
            ) : null}
            {conversation.priority ? <PriorityBadge priority={conversation.priority} /> : null}
            {conversation.sla ? <SlaBadge sla={conversation.sla} /> : null}
            {conversation.aiDraftReady ? (
              <StatusBadge
                tone="info"
                icon={<SparklesIcon className="size-3.5" aria-hidden="true" />}
                data-testid="draft-ready"
              >
                {t('inbox.aiDrafts.badge')}
              </StatusBadge>
            ) : null}
            <OwnerBadge conversation={conversation} />
            {/* A ticket's state already says whether it waits or is closed. */}
            {!conversation.ticket &&
            (conversation.status === 'snoozed' || conversation.status === 'resolved') ? (
              <ConversationStatusBadge
                status={conversation.status}
                snoozedUntil={conversation.snoozedUntil}
              />
            ) : null}
            {conversation.customer.identity === 'verified' ? (
              <span className="text-xs text-success">{t('inbox.identity.verified')}</span>
            ) : null}
            <ChannelIcon channel={conversation.channel} />
            {language ? (
              <span className="text-xs text-text-secondary">
                <bdi>{language}</bdi>
              </span>
            ) : null}
            {conversation.brand ? (
              <span className="text-xs text-text-secondary">
                <bdi>{conversation.brand.name}</bdi>
              </span>
            ) : null}
            {conversation.team ? (
              <span className="text-xs text-text-secondary">
                {t('inbox.row.team', { name: conversation.team.name })}
              </span>
            ) : null}
            {conversation.labels.slice(0, 2).map((label) => (
              <StatusBadge key={label} tone="neutral" icon={null} className="h-5">
                <bdi>{label}</bdi>
              </StatusBadge>
            ))}
          </span>
        </span>
      </Link>
    </li>
  );
}

function QueueNav({ counts }: { counts: Record<(typeof QUEUES)[number], number> | undefined }) {
  const { t } = useTranslation();
  const search = useSearch({ from: '/_studio/inbox' });
  const current = search.queue ?? 'all';
  return (
    <nav aria-label={t('inbox.queues.label')}>
      <ul className="flex flex-wrap gap-1">
        {QUEUES.map((queue) => (
          <li key={queue}>
            <Link
              to="."
              search={(prev: InboxSearch) => {
                // A ticket's state and priority belong to the tickets queue.
                const { queue: _old, ticketState: _state, priority: _priority, ...rest } = prev;
                return queue === 'all' ? rest : { ...rest, queue };
              }}
              aria-current={current === queue ? 'page' : undefined}
              data-queue={queue}
              className={cn(
                'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm whitespace-nowrap',
                current === queue
                  ? 'border-text bg-text font-medium text-bg'
                  : 'border-border bg-surface text-text-secondary hover:bg-surface-sunken',
              )}
            >
              {t(`inbox.queues.${queue}`)}
              {counts && counts[queue] !== undefined ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-xs',
                    current === queue ? 'bg-bg/20' : 'bg-surface-sunken',
                  )}
                >
                  {formatNumber(counts[queue])}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The tickets queue's own filters: where the tickets stand (Open, Pending, Closed or all of them)
 * and their priority. Both are in the address, so a view of tickets can be shared.
 */
function TicketFilters() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/inbox' });
  const current = search.ticketState ?? 'all';
  return (
    <div className="flex flex-col gap-3" data-testid="ticket-filters">
      <nav aria-label={t('inbox.tickets.states.label')}>
        <ul className="flex flex-wrap gap-1">
          {(['open', 'pending', 'closed', 'all'] as const).map((state) => (
            <li key={state}>
              <Link
                to="."
                search={(prev: InboxSearch) => {
                  const { ticketState: _old, ...rest } = prev;
                  return state === 'all' ? rest : { ...rest, ticketState: state };
                }}
                aria-current={current === state ? 'page' : undefined}
                data-ticket-state={state}
                className={cn(
                  'inline-flex min-h-8 items-center rounded-full border px-3 text-sm whitespace-nowrap',
                  current === state
                    ? 'border-text bg-surface-muted font-medium text-text'
                    : 'border-border bg-surface text-text-secondary hover:bg-surface-sunken',
                )}
              >
                {t(`inbox.tickets.states.${state}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-48">
          <SelectField
            id="inbox-priority"
            label={t('inbox.tickets.priority.label')}
            value={search.priority ?? ''}
            onChange={(event) =>
              void navigate({
                to: '.',
                search: (prev: InboxSearch) => {
                  const { priority: _old, ...rest } = prev;
                  const priority = PRIORITIES.find((value) => value === event.target.value);
                  return priority ? { ...rest, priority } : rest;
                },
              })
            }
            options={[
              { value: '', label: t('inbox.tickets.priority.any') },
              ...PRIORITIES.map((value) => ({
                value,
                label: t(`inbox.tickets.priority.${value}`),
              })),
            ]}
          />
        </div>
        <GuideLink href={DOCS.inbox.tickets}>{t('inbox.tickets.guide')}</GuideLink>
      </div>
    </div>
  );
}

function FilterPanel({ rows, onClose }: { rows: InboxConversation[]; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/inbox' });
  const brands = useBrandRefs();
  const brandOptions = useMemo(() => {
    const known = new Map<string, string>();
    for (const b of brands.items ?? []) known.set(b.id, b.name);
    for (const row of rows) if (row.brand) known.set(row.brand.id, row.brand.name);
    return [...known].map(([value, label]) => ({ value, label }));
  }, [brands.items, rows]);
  const languages = useMemo(() => {
    const tags = new Set(rows.map((r) => r.customer.language).filter(Boolean) as string[]);
    if (search.language) tags.add(search.language);
    return [...tags].map((value) => ({ value, label: languageName(value) ?? value }));
  }, [rows, search.language]);
  const tags = useMemo(() => {
    const labels = new Set(rows.flatMap((r) => r.labels));
    if (search.tag) labels.add(search.tag);
    return [...labels].sort().map((value) => ({ value, label: value }));
  }, [rows, search.tag]);

  const set = (key: keyof InboxSearch, value: string) =>
    void navigate({
      to: '.',
      search: (prev: InboxSearch) => {
        const next: Record<string, unknown> = { ...prev };
        if (value) next[key] = value;
        else delete next[key];
        return next as InboxSearch;
      },
    });

  return (
    <section
      aria-labelledby="inbox-filters-title"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted p-3"
      data-testid="inbox-filters"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="inbox-filters-title" className="text-sm font-semibold text-text">
          {t('inbox.filters.title')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('inbox.filters.close')}
          onClick={onClose}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {/* In the tickets queue, a ticket's state (above the list) takes the status's place. */}
        {search.queue === 'tickets' ? null : (
          <SelectField
            id="inbox-status"
            label={t('inbox.filters.status')}
            value={search.status ?? 'active'}
            onChange={(event) =>
              set('status', event.target.value === 'active' ? '' : event.target.value)
            }
            options={STATUSES.map((value) => ({
              value,
              label: t(`inbox.filters.statuses.${value}`),
            }))}
          />
        )}
        <SelectField
          id="inbox-brand"
          label={t('inbox.filters.brand')}
          value={search.brand ?? ''}
          onChange={(event) => set('brand', event.target.value)}
          options={[{ value: '', label: t('inbox.filters.allBrands') }, ...brandOptions]}
        />
        <SelectField
          id="inbox-channel"
          label={t('inbox.filters.channel')}
          value={search.channel ?? ''}
          onChange={(event) => set('channel', event.target.value)}
          options={[
            { value: '', label: t('inbox.filters.allChannels') },
            ...CHANNELS.map((value) => ({ value, label: t(`inbox.channel.${value}`) })),
          ]}
        />
        <SelectField
          id="inbox-language"
          label={t('inbox.filters.language')}
          value={search.language ?? ''}
          onChange={(event) => set('language', event.target.value)}
          options={[{ value: '', label: t('inbox.filters.allLanguages') }, ...languages]}
        />
        <SelectField
          id="inbox-tag"
          label={t('inbox.filters.tag')}
          value={search.tag ?? ''}
          onChange={(event) => set('tag', event.target.value)}
          options={[{ value: '', label: t('inbox.filters.allTags') }, ...tags]}
        />
      </div>
    </section>
  );
}

const FILTER_KEYS = ['status', 'brand', 'channel', 'language', 'tag'] as const;
const TICKET_FILTER_KEYS = ['ticketState', 'priority'] as const;

/** The filters in use; the tickets queue has no status filter (its tickets' state replaces it). */
function activeFilters(search: InboxSearch) {
  return FILTER_KEYS.filter(
    (key) => Boolean(search[key]) && !(key === 'status' && search.queue === 'tickets'),
  );
}

function SearchResults({ q }: { q: string }) {
  const { t } = useTranslation();
  const search = useInboxSearch(q);
  const merged = useMemo(
    () =>
      search.data
        ? {
            conversations: search.data.pages[0]?.conversations ?? [],
            messages: search.data.pages.flatMap((page) => page.messages),
          }
        : undefined,
    [search.data],
  );
  const result = { ...search, data: merged };
  const navigate = useNavigate();
  const clear = () =>
    void navigate({
      to: '.',
      search: (prev: InboxSearch) => {
        const { q: _q, ...rest } = prev;
        return rest;
      },
    });
  if (q.trim().length < 2) {
    return <p className="p-4 text-sm text-text-secondary">{t('inbox.search.tooShort')}</p>;
  }
  return (
    <div className="p-3" data-testid="search-results">
      <QueryState
        query={result}
        label={t('inbox.search.loading')}
        isEmpty={(data) => data.conversations.length === 0 && data.messages.length === 0}
        empty={
          <EmptyState
            kind="no-matches"
            title={t('inbox.search.none')}
            description={t('inbox.search.noneHint')}
            action={
              <Button variant="secondary" onClick={clear}>
                {t('inbox.search.clear')}
              </Button>
            }
          />
        }
      >
        {(data) => (
          <div className="flex flex-col gap-4">
            <p role="status" className="text-sm text-text-secondary">
              {t('inbox.search.found', {
                conversations: formatNumber(data.conversations.length),
                messages: formatNumber(data.messages.length),
              })}
            </p>
            {data.conversations.length > 0 ? (
              <section aria-labelledby="search-conversations" className="flex flex-col gap-2">
                <h2 id="search-conversations" className="text-sm font-semibold text-text">
                  {t('inbox.search.conversations')}
                </h2>
                <ul className="flex flex-col gap-1">
                  {data.conversations.map((c) => (
                    <li key={c.id}>
                      <Link
                        to="/inbox/$conversationId"
                        params={{ conversationId: c.id }}
                        search={(prev: InboxSearch) => prev}
                        className="flex flex-col rounded-md border border-border bg-surface p-2 hover:bg-surface-sunken"
                      >
                        <span className="font-medium text-text">
                          <bdi>{c.customer.displayName}</bdi>
                        </span>
                        <RowPreview conversation={c} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {data.messages.length > 0 ? (
              <section aria-labelledby="search-messages" className="flex flex-col gap-2">
                <h2 id="search-messages" className="text-sm font-semibold text-text">
                  {t('inbox.search.messages')}
                </h2>
                <ul className="flex flex-col gap-1">
                  {data.messages.map((m) => (
                    <li key={m.messageId}>
                      <Link
                        to="/inbox/$conversationId"
                        params={{ conversationId: m.conversationId }}
                        search={(prev: InboxSearch) => prev}
                        className="flex flex-col gap-1 rounded-md border border-border bg-surface p-2 hover:bg-surface-sunken"
                        data-testid="search-message"
                      >
                        <span className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                          <bdi className="font-medium text-text">{m.sender.displayName}</bdi>
                          {m.visibility === 'internal' ? (
                            <span className="inline-flex items-center gap-1">
                              <LockIcon className="size-3" aria-hidden="true" />
                              {t('inbox.lanes.internal')}
                            </span>
                          ) : null}
                          <time dateTime={m.createdAt}>{shortTime(m.createdAt)}</time>
                        </span>
                        <bdi dir="auto" className="text-sm text-text">
                          {m.snippet}
                        </bdi>
                      </Link>
                    </li>
                  ))}
                </ul>
                {search.hasNextPage ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="self-start"
                    busy={search.isFetchingNextPage}
                    onClick={() => void search.fetchNextPage()}
                  >
                    {t('inbox.search.more')}
                  </Button>
                ) : null}
              </section>
            ) : null}
          </div>
        )}
      </QueryState>
    </div>
  );
}

function QueuePane({ open, selectedId }: { open: boolean; selectedId: string | undefined }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/inbox' });
  const list = useInboxList(search);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState(search.q ?? '');
  const [activeId, setActiveId] = useState<string | undefined>(selectedId);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const announce = useAnnouncer();
  const selectable = can('conversations.bulk');

  useEffect(() => setQuery(search.q ?? ''), [search.q]);
  useEffect(() => {
    if (selectedId) setActiveId(selectedId);
  }, [selectedId]);

  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const counts = list.data?.pages[0]?.counts;
  const filters = activeFilters(search);
  const tickets = search.queue === 'tickets';
  const ticketFilters = tickets ? TICKET_FILTER_KEYS.filter((key) => Boolean(search[key])) : [];
  const tabStop = rows.some((r) => r.id === activeId) ? activeId : rows[0]?.id;

  // Coming back from a conversation (Esc, or Back on a phone): focus returns to its row, or to
  // the first row when it has left this queue (taken over from "Waiting", for example).
  useLayoutEffect(() => {
    if (open || !returnFocusTo || rows.length === 0) return;
    const id = returnFocusTo;
    returnFocusTo = null;
    const present = rows.some((r) => r.id === id);
    if (present) setActiveId(id);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const list = listRef.current;
        const row =
          (present
            ? list?.querySelector<HTMLElement>(`[data-conversation-id="${id}"] [data-row-link]`)
            : null) ?? list?.querySelector<HTMLElement>('[data-row-link][tabindex="0"]');
        row?.focus();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open, rows]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const name = rows.find((r) => r.id === id)?.customer.displayName ?? '';
      announce(
        next.has(id)
          ? t('inbox.bulk.selected', { name, n: next.size })
          : t('inbox.bulk.unselected', { name, n: next.size }),
      );
      return next;
    });

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const links = [
      ...(listRef.current?.querySelectorAll<HTMLAnchorElement>('[data-row-link]') ?? []),
    ];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    let next = -1;
    switch (event.key) {
      case 'ArrowDown':
      case 'j':
        next = Math.min(index + 1, links.length - 1);
        break;
      case 'ArrowUp':
      case 'k':
        next = Math.max(index - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = links.length - 1;
        break;
      case 'x': {
        const id = rows[index]?.id;
        if (selectable && id) {
          event.preventDefault();
          toggle(id);
        }
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    links[next]?.focus();
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    void navigate({
      to: '.',
      search: (prev: InboxSearch) => {
        const { q: _q, ...rest } = prev;
        return q ? { ...rest, q } : rest;
      },
    });
  };

  const clearFilters = () =>
    void navigate({
      to: '.',
      search: (prev: InboxSearch) => {
        const next: Record<string, unknown> = { ...prev };
        for (const key of FILTER_KEYS) delete next[key];
        return next as InboxSearch;
      },
    });
  const clearTicketFilters = () =>
    void navigate({
      to: '.',
      search: (prev: InboxSearch) => {
        const { ticketState: _state, priority: _priority, ...rest } = prev;
        return rest;
      },
    });

  return (
    <section
      aria-labelledby={open ? 'inbox-heading' : 'page-title'}
      className={cn(
        'flex w-full min-w-0 flex-col border-border bg-surface lg:h-full lg:w-80 lg:shrink-0 lg:border-e xl:w-96',
        open ? 'hidden lg:flex' : 'flex',
      )}
      data-testid="inbox-queue"
    >
      <div className="flex flex-col gap-3 border-b border-border p-4">
        <div className="flex items-center justify-between gap-2">
          <h1
            id={open ? 'inbox-heading' : 'page-title'}
            tabIndex={-1}
            className="flex items-center gap-2 text-2xl font-semibold text-text"
          >
            {t('inbox.title')}
          </h1>
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={filtersOpen}
            aria-controls="inbox-filters-panel"
            onClick={() => setFiltersOpen((value) => !value)}
          >
            <ListFilterIcon aria-hidden="true" />
            {filters.length > 0
              ? t('inbox.filters.buttonCount', { n: filters.length })
              : t('inbox.filters.button')}
          </Button>
        </div>
        <search>
          <form onSubmit={submitSearch} className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t('inbox.search.label')}
                placeholder={t('inbox.search.placeholder')}
                className="ps-9"
                dir={query ? 'auto' : undefined}
                data-testid="inbox-search"
              />
            </div>
            <Button type="submit" variant="secondary">
              {t('inbox.search.submit')}
            </Button>
          </form>
        </search>
        <InboxToolbar />
        <DesktopAlertsPrompt />
        {search.q ? null : <QueueNav counts={counts} />}
        {tickets && !search.q ? <TicketFilters /> : null}
        <div id="inbox-filters-panel">
          {filtersOpen ? <FilterPanel rows={rows} onClose={() => setFiltersOpen(false)} /> : null}
        </div>
        {filters.length > 0 && !search.q ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span>{t('inbox.filters.active', { n: filters.length })}</span>
            <Button variant="link" size="sm" onClick={clearFilters} data-testid="clear-filters">
              {t('inbox.filters.clear')}
            </Button>
          </p>
        ) : null}
        <p id="inbox-keys" className="hidden text-xs text-text-muted lg:block">
          {selectable ? t('inbox.keys.withSelect') : t('inbox.keys.plain')}
        </p>
      </div>

      {selectable && picked.size > 0 ? (
        <BulkBar
          ids={[...picked]}
          rows={rows}
          onDone={(remaining) => setPicked(new Set(remaining))}
          onClear={() => setPicked(new Set())}
        />
      ) : null}

      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        <UrgentSection />
        {search.q ? (
          <SearchResults q={search.q} />
        ) : (
          <QueryState
            query={{ ...list, data: list.data ? rows : undefined }}
            label={t('inbox.loading')}
            skeleton={
              <div className="p-4">
                <ListSkeleton rows={6} />
              </div>
            }
            isEmpty={(items) => items.length === 0}
            empty={
              <div className="p-4">
                {ticketFilters.length > 0 && filters.length === 0 ? (
                  <EmptyState
                    kind="no-matches"
                    title={t('inbox.tickets.emptyFiltered.title')}
                    description={t('inbox.tickets.emptyFiltered.description')}
                    action={
                      <Button variant="secondary" onClick={clearTicketFilters}>
                        {t('inbox.tickets.emptyFiltered.action')}
                      </Button>
                    }
                  />
                ) : filters.length > 0 ? (
                  <EmptyState
                    kind="no-matches"
                    title={t('inbox.empty.filteredTitle')}
                    description={t('inbox.empty.filteredDescription')}
                    action={
                      <Button variant="secondary" onClick={clearFilters}>
                        {t('inbox.filters.clear')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    kind="no-records"
                    title={t(`inbox.empty.${search.queue ?? 'all'}.title`)}
                    description={t(`inbox.empty.${search.queue ?? 'all'}.description`)}
                    icon={<InboxIcon className="size-6 text-text-muted" aria-hidden="true" />}
                    action={
                      search.queue && search.queue !== 'all' ? (
                        <Button asChild variant="secondary">
                          <Link to="/inbox" search={{}}>
                            {t('inbox.empty.seeAll')}
                          </Link>
                        </Button>
                      ) : (
                        <Button asChild variant="secondary">
                          <Link to="/overview">{t('inbox.empty.overview')}</Link>
                        </Button>
                      )
                    }
                  />
                )}
              </div>
            }
          >
            {(items) => (
              <>
                <p className="sr-only" role="status">
                  {t('inbox.shown', { n: items.length })}
                </p>
                <ul
                  ref={listRef}
                  aria-label={t(`inbox.queues.${search.queue ?? 'all'}`)}
                  aria-describedby="inbox-keys"
                  onKeyDown={onKeyDown}
                  data-testid="inbox-list"
                >
                  {items.map((conversation) => (
                    <QueueRow
                      key={conversation.id}
                      conversation={conversation}
                      selected={conversation.id === selectedId}
                      active={conversation.id === tabStop}
                      checked={picked.has(conversation.id)}
                      selectable={selectable}
                      onToggle={toggle}
                      onFocusRow={setActiveId}
                    />
                  ))}
                </ul>
                {list.hasNextPage ? (
                  <div className="p-3">
                    <Button
                      variant="secondary"
                      className="w-full"
                      busy={list.isFetchingNextPage}
                      onClick={() => void list.fetchNextPage()}
                    >
                      {t('inbox.loadMore')}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </QueryState>
        )}
      </div>
    </section>
  );
}

/** Shown beside the queue until a conversation is opened (wide screens only). */
export function NoConversationPane() {
  const { t } = useTranslation();
  return (
    <div className="hidden flex-1 items-center justify-center p-8 lg:flex">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <MessagesSquareIcon className="size-8 text-text-muted" aria-hidden="true" />
        <p className="font-medium text-text">{t('inbox.pick.title')}</p>
        <p className="text-sm text-text-secondary">{t('inbox.pick.description')}</p>
      </div>
    </div>
  );
}

/**
 * The shared inbox (boards 08–10): the queue, the open conversation and its details. Wide screens
 * show them side by side; on a phone they are steps (queue → conversation → details).
 */
export function InboxPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const params = useParams({ strict: false }) as { conversationId?: string };
  const permitted = can('conversations.read');
  const stream = useInboxStream(permitted);
  const online = useOnline();
  useDocumentTitle(t('inbox.title'));

  if (!permitted) {
    return (
      <div className="flex flex-col gap-6">
        <h1 id="page-title" tabIndex={-1} className="text-2xl font-semibold text-text">
          {t('inbox.title')}
        </h1>
        <Forbidden
          title={t('inbox.forbidden.title')}
          description={t('inbox.forbidden.description')}
        />
      </div>
    );
  }

  const open = Boolean(params.conversationId);
  const connection = !online ? 'offline' : stream === 'reconnecting' ? 'reconnecting' : 'online';
  return (
    <div className="-mx-4 -my-6 flex min-w-0 flex-1 flex-col sm:-mx-6 lg:-mx-8">
      <ConnectionBanner
        state={connection}
        message={
          connection === 'offline'
            ? t('inbox.connection.offline')
            : t('inbox.connection.reconnecting')
        }
        data-testid="inbox-connection"
      />
      <div className="flex min-w-0 flex-1 flex-col lg:h-[calc(100dvh-4rem)] lg:flex-row lg:overflow-hidden">
        <QueuePane open={open} selectedId={params.conversationId} />
        <div className={cn('min-w-0 flex-1', open ? 'flex' : 'hidden lg:flex')}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
