import { Button } from '@hamnivo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@hamnivo/ui/components/dropdown-menu';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@hamnivo/ui/components/sheet';
import { Skeleton } from '@hamnivo/ui/components/skeleton';
import { cn } from '@hamnivo/ui/lib/utils';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  HandIcon,
  InfoIcon,
  MoonIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RotateCcwIcon,
  UserRoundCheckIcon,
  UserRoundIcon,
  UsersRoundIcon,
  XIcon,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { TextareaField, TextField } from '../../components/Fields';
import { useDocumentTitle } from '../../components/PageHeader';
import { ActionError, ErrorPanel } from '../../components/States';
import { directionOf, isLocale } from '../../i18n';
import { api, isApiError } from '../../lib/api';
import { returnFocus, useOpener } from '../../lib/focus';
import { formatDateTime, formatRelative } from '../../lib/format';
import {
  type AssignTarget,
  assign,
  chronological,
  type InboxDetail,
  type InboxSearch,
  newClientId,
  sendPresence,
  setStatus,
  useAssignees,
  useConversation,
  useConversationChange,
  useDrafts,
  useMessages,
} from '../../lib/inbox';
import { useTenant } from '../../lib/tenant';
import { Composer } from './Composer';
import { ContextPanel } from './ContextPanel';
import { returnToQueue } from './InboxPage';
import {
  ChannelIcon,
  ConversationStatusBadge,
  IdentityBadge,
  languageName,
  OwnerBadge,
  useMyStaffId,
} from './parts';
import { Timeline } from './Timeline';

const DETAILS_KEY = 'hamnivo.studio.inbox.details';

function detailsPreference(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

/** Ownership in words: who answers, and whether this person may send a reply now. */
export function ownership(detail: InboxDetail, me: string | null) {
  const mine =
    detail.ownerMode === 'HUMAN_ACTIVE' &&
    detail.owner.kind === 'staff' &&
    detail.owner.staffMemberId === me;
  const byOther = detail.ownerMode === 'HUMAN_ACTIVE' && !mine;
  return { mine, byOther };
}

function snoozeTimes(now = new Date()) {
  const inHour = new Date(now.getTime() + 60 * 60_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  nextWeek.setHours(9, 0, 0, 0);
  return { inHour, tomorrow, nextWeek };
}

/** A local date-time value ("2026-09-27T14:30") for <input type="datetime-local">. */
function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function TransferDialog({
  open,
  onOpenChange,
  detail,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: InboxDetail;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [note, setNote] = useState('');
  const request = useConversationChange(
    detail.id,
    (vars: { note: string }, tenantId) =>
      api<void>(`/v1/inbox/conversations/${detail.id}/transfer-request`, {
        method: 'POST',
        tenant: tenantId,
        body: { clientRequestId: newClientId(), ...(vars.note ? { note: vars.note } : {}) },
      }),
    ['messages'],
  );
  const owner = detail.owner.kind === 'staff' ? detail.owner.displayName : t('inbox.owner.person');
  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!request.isPending) onOpenChange(next);
      }}
      title={t('inbox.transfer.title')}
      description={t('inbox.transfer.description', { name: owner })}
      testId="transfer-dialog"
    >
      <TextareaField
        id="transfer-note"
        label={t('inbox.transfer.note')}
        labelNote={t('app.optional')}
        value={note}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
      />
      <ActionError error={request.error} />
      <DialogFooter>
        <Button
          variant="secondary"
          onClick={() => onOpenChange(false)}
          disabled={request.isPending}
        >
          {t('app.cancel')}
        </Button>
        <Button
          busy={request.isPending}
          onClick={() =>
            request.mutate(
              { note: note.trim() },
              {
                onSuccess: () => {
                  announce(t('inbox.transfer.sent', { name: owner }));
                  setNote('');
                  onOpenChange(false);
                },
              },
            )
          }
        >
          {t('inbox.transfer.send')}
        </Button>
      </DialogFooter>
    </AppDialog>
  );
}

function SnoozeDialog({
  open,
  onOpenChange,
  onSnooze,
  busy,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (until: Date) => void;
  busy: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(() => localInputValue(snoozeTimes().tomorrow));
  const [invalid, setInvalid] = useState(false);
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('inbox.snooze.pickTitle')}
      description={t('inbox.snooze.pickDescription')}
      testId="snooze-dialog"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const until = new Date(value);
          if (!value || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          onSnooze(until);
        }}
      >
        <TextField
          id="snooze-until"
          type="datetime-local"
          label={t('inbox.snooze.until')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          error={invalid ? t('inbox.snooze.future') : undefined}
          required
        />
        <ActionError error={error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={busy}>
            {t('inbox.snooze.confirm')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function AssignMenu({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const me = useMyStaffId();
  const { mine, byOther } = ownership(detail, me);
  const [open, setOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const can = detail.permissions;
  const options = useAssignees(detail.id, open && can.assign);
  const change = useConversationChange(
    detail.id,
    (to: AssignTarget, tenantId) => assign(tenantId, detail.id, to, detail.ownershipEpoch),
    ['messages', 'assignees'],
  );
  const team = useConversationChange(
    detail.id,
    (teamId: string | null, tenantId) =>
      api<InboxDetail>(`/v1/inbox/conversations/${detail.id}/team`, {
        method: 'POST',
        tenant: tenantId,
        body: { teamId },
      }),
    ['assignees'],
  );
  const run = (to: AssignTarget, done: string) =>
    change.mutate(to, { onSuccess: () => announce(done) });

  const canClaim = !mine && can.takeover && (!byOther || can.assign);
  const canRelease = (mine && can.takeover) || (can.assign && detail.ownerMode !== 'WAITING_HUMAN');
  const aiReady = options.data?.ai.available ?? detail.aiAvailable;
  const canAi = detail.ownerMode !== 'AI_ACTIVE' && aiReady && (mine || can.assign);
  const askTransfer = byOther && !can.assign && can.note;
  const anything = canClaim || canRelease || canAi || can.assign || askTransfer;

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            busy={change.isPending || team.isPending}
            disabled={!anything}
            data-testid="assign-menu"
          >
            <UsersRoundIcon aria-hidden="true" />
            {t('inbox.assign.button')}
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {canClaim ? (
            <DropdownMenuItem onSelect={() => run({ kind: 'me' }, t('inbox.assign.doneMe'))}>
              <UserRoundCheckIcon aria-hidden="true" />
              {t('inbox.assign.me')}
            </DropdownMenuItem>
          ) : null}
          {can.assign ? (
            <>
              <DropdownMenuLabel>{t('inbox.assign.colleagues')}</DropdownMenuLabel>
              {options.isPending ? (
                <DropdownMenuItem disabled>{t('app.loading')}</DropdownMenuItem>
              ) : (
                (options.data?.staff ?? [])
                  .filter((s) => s.staffMemberId !== me)
                  .map((s) => (
                    <DropdownMenuItem
                      key={s.staffMemberId}
                      disabled={s.current}
                      onSelect={() =>
                        run(
                          { kind: 'staff', staffMemberId: s.staffMemberId },
                          t('inbox.assign.doneTo', { name: s.displayName }),
                        )
                      }
                    >
                      <UserRoundIcon aria-hidden="true" />
                      <bdi>{s.displayName}</bdi>
                      {s.current ? (
                        <span className="ms-auto text-xs text-text-secondary">
                          {t('inbox.assign.current')}
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  ))
              )}
            </>
          ) : null}
          {canRelease || canAi ? <DropdownMenuSeparator /> : null}
          {canRelease ? (
            <DropdownMenuItem onSelect={() => run({ kind: 'queue' }, t('inbox.assign.doneQueue'))}>
              <HandIcon aria-hidden="true" />
              {t('inbox.assign.queue')}
            </DropdownMenuItem>
          ) : null}
          {canAi ? (
            <DropdownMenuItem onSelect={() => run({ kind: 'ai' }, t('inbox.assign.doneAi'))}>
              <BotIcon aria-hidden="true" />
              {t('inbox.assign.ai')}
            </DropdownMenuItem>
          ) : null}
          {can.assign ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <UsersRoundIcon aria-hidden="true" />
                  {detail.team
                    ? t('inbox.assign.teamCurrent', { name: detail.team.name })
                    : t('inbox.assign.team')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {(options.data?.teams ?? []).map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      disabled={detail.team?.id === item.id}
                      onSelect={() =>
                        team.mutate(item.id, {
                          onSuccess: () =>
                            announce(t('inbox.assign.doneTeam', { name: item.name })),
                        })
                      }
                    >
                      <bdi>{item.name}</bdi>
                    </DropdownMenuItem>
                  ))}
                  {(options.data?.teams ?? []).length === 0 && !options.isPending ? (
                    <DropdownMenuItem disabled>{t('inbox.assign.noTeams')}</DropdownMenuItem>
                  ) : null}
                  {detail.team ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        team.mutate(null, {
                          onSuccess: () => announce(t('inbox.assign.doneNoTeam')),
                        })
                      }
                    >
                      {t('inbox.assign.noTeam')}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          ) : null}
          {askTransfer ? (
            <DropdownMenuItem onSelect={() => setTransferOpen(true)}>
              <HandIcon aria-hidden="true" />
              {t('inbox.transfer.ask')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {change.error || team.error ? (
        <div className="basis-full">
          <ActionError error={change.error ?? team.error} />
        </div>
      ) : null}
      <TransferDialog open={transferOpen} onOpenChange={setTransferOpen} detail={detail} />
    </>
  );
}

function StatusActions({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [pickOpen, setPickOpen] = useState(false);
  const change = useConversationChange(
    detail.id,
    (body: { status: 'open' | 'resolved' | 'snoozed'; snoozedUntil?: string }, tenantId) =>
      setStatus(tenantId, detail.id, { ...body, expectedEpoch: detail.ownershipEpoch }),
    ['messages'],
  );
  if (!detail.permissions.status) return null;
  const snooze = (until: Date) =>
    change.mutate(
      { status: 'snoozed', snoozedUntil: until.toISOString() },
      {
        onSuccess: () => {
          setPickOpen(false);
          announce(t('inbox.snooze.done', { time: formatDateTime(until.toISOString()) }));
        },
      },
    );
  const times = snoozeTimes();
  if (detail.status === 'resolved' || detail.status === 'snoozed') {
    return (
      <>
        <Button
          size="sm"
          variant="secondary"
          busy={change.isPending}
          onClick={() =>
            change.mutate(
              { status: 'open' },
              { onSuccess: () => announce(t('inbox.status.reopened')) },
            )
          }
          data-testid="reopen"
        >
          <RotateCcwIcon aria-hidden="true" />
          {detail.status === 'snoozed' ? t('inbox.status.wake') : t('inbox.status.reopen')}
        </Button>
        {change.error ? (
          <div className="basis-full">
            <ActionError error={change.error} />
          </div>
        ) : null}
      </>
    );
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="secondary"
            disabled={change.isPending}
            data-testid="snooze-menu"
          >
            <MoonIcon aria-hidden="true" />
            {t('inbox.snooze.button')}
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => snooze(times.inHour)}>
            {t('inbox.snooze.hour')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => snooze(times.tomorrow)}>
            {t('inbox.snooze.tomorrow', { time: formatDateTime(times.tomorrow.toISOString()) })}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => snooze(times.nextWeek)}>
            {t('inbox.snooze.nextWeek', { time: formatDateTime(times.nextWeek.toISOString()) })}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPickOpen(true)}>
            {t('inbox.snooze.pick')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        busy={change.isPending}
        onClick={() =>
          change.mutate(
            { status: 'resolved' },
            { onSuccess: () => announce(t('inbox.status.resolvedDone')) },
          )
        }
        data-testid="resolve"
      >
        <CheckCircle2Icon aria-hidden="true" />
        {t('inbox.status.resolve')}
      </Button>
      {change.error && !pickOpen ? (
        <div className="basis-full">
          <ActionError error={change.error} />
        </div>
      ) : null}
      <SnoozeDialog
        open={pickOpen}
        onOpenChange={setPickOpen}
        onSnooze={snooze}
        busy={change.isPending}
        error={change.error}
      />
    </>
  );
}

/** What the person can do about ownership right now, in one sentence and one or two buttons. */
function OwnershipBanner({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const me = useMyStaffId();
  const { mine, byOther } = ownership(detail, me);
  const [transferOpen, setTransferOpen] = useState(false);
  const claim = useConversationChange(
    detail.id,
    (_: undefined, tenantId) => assign(tenantId, detail.id, { kind: 'me' }, detail.ownershipEpoch),
    ['messages'],
  );
  if (mine) return null;
  const can = detail.permissions;
  const since = detail.ownerChangedAt ? formatRelative(detail.ownerChangedAt) : null;
  let text: string;
  let tone: 'info' | 'warning' = 'warning';
  if (byOther) {
    const name =
      detail.owner.kind === 'staff' ? detail.owner.displayName : t('inbox.owner.external');
    text = since
      ? t('inbox.banner.otherSince', { name, time: since })
      : t('inbox.banner.other', { name });
  } else if (detail.ownerMode === 'AI_ACTIVE') {
    tone = 'info';
    text = t('inbox.banner.ai', {
      name: detail.owner.kind === 'ai' ? detail.owner.displayName : t('inbox.owner.ai'),
    });
  } else if (detail.ownerReason === 'customer_request') {
    text = since ? t('inbox.banner.askedSince', { time: since }) : t('inbox.banner.asked');
  } else if (detail.ownerReason === 'staff_release') {
    text = t('inbox.banner.released');
  } else {
    text = t('inbox.banner.waiting');
  }
  const canClaim = can.takeover && (!byOther || can.assign);
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm',
        tone === 'info' ? 'border-info/30 bg-info-subtle' : 'border-warning/40 bg-warning-subtle',
      )}
      data-testid="ownership-banner"
    >
      {tone === 'info' ? (
        <BotIcon className="size-4 shrink-0 text-info" aria-hidden="true" />
      ) : (
        <InfoIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
      )}
      <p className="min-w-0 flex-1 text-text">
        <bdi>{text}</bdi>
        {byOther ? (
          <span className="text-text-secondary"> {t('inbox.banner.notesStill')}</span>
        ) : null}
      </p>
      {canClaim ? (
        <Button
          size="sm"
          busy={claim.isPending}
          onClick={() =>
            claim.mutate(undefined, { onSuccess: () => announce(t('inbox.assign.doneMe')) })
          }
          data-testid="take-over"
        >
          {byOther || detail.ownerMode === 'AI_ACTIVE'
            ? t('inbox.banner.takeOver')
            : t('inbox.banner.claim')}
        </Button>
      ) : byOther && can.note ? (
        <Button size="sm" variant="secondary" onClick={() => setTransferOpen(true)}>
          {t('inbox.transfer.ask')}
        </Button>
      ) : null}
      {claim.error ? (
        <div className="basis-full">
          {isApiError(claim.error, 'OWNERSHIP_CHANGED') ? (
            <p role="alert" className="text-sm font-medium text-text">
              {t('inbox.banner.claimLost')}
            </p>
          ) : (
            <ActionError error={claim.error} />
          )}
        </div>
      ) : null}
      <TransferDialog open={transferOpen} onOpenChange={setTransferOpen} detail={detail} />
    </div>
  );
}

function Presence({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  if (detail.presence.length === 0) return null;
  return (
    <p className="text-xs text-text-secondary" data-testid="presence">
      {detail.presence
        .map((p) =>
          p.state === 'typing'
            ? t(
                p.lane === 'internal' ? 'inbox.presence.typingNote' : 'inbox.presence.typingReply',
                {
                  name: p.displayName,
                },
              )
            : t('inbox.presence.viewing', { name: p.displayName }),
        )
        .join(' · ')}
    </p>
  );
}

function Header({
  detail,
  onBack,
  detailsOpen,
  onToggleDetails,
}: {
  detail: InboxDetail;
  onBack: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const { t } = useTranslation();
  const language = languageName(detail.customer.language);
  return (
    <header className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          onClick={onBack}
          aria-label={t('inbox.back')}
          data-testid="back-to-queue"
        >
          <ArrowLeftIcon className="rtl:-scale-x-100" aria-hidden="true" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2
            id="page-title"
            tabIndex={-1}
            className="truncate text-xl font-semibold text-text outline-none"
            data-testid="conversation-title"
          >
            <bdi>{detail.customer.displayName}</bdi>
          </h2>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
            <IdentityBadge identity={detail.customer.identity} />
            <ConversationStatusBadge status={detail.status} snoozedUntil={detail.snoozedUntil} />
            <OwnerBadge conversation={detail} />
            <ChannelIcon channel={detail.channel} />
            {language ? <bdi>{language}</bdi> : null}
            {detail.brand ? <bdi>{detail.brand.name}</bdi> : null}
            {detail.team ? <span>{t('inbox.row.team', { name: detail.team.name })}</span> : null}
          </div>
          <Presence detail={detail} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AssignMenu detail={detail} />
        <StatusActions detail={detail} />
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto"
          onClick={onToggleDetails}
          aria-expanded={detailsOpen}
          data-testid="details-toggle"
        >
          {detailsOpen ? (
            <PanelRightCloseIcon className="rtl:-scale-x-100" aria-hidden="true" />
          ) : (
            <PanelRightOpenIcon className="rtl:-scale-x-100" aria-hidden="true" />
          )}
          {detailsOpen ? t('inbox.details.hide') : t('inbox.details.show')}
        </Button>
      </div>
    </header>
  );
}

function PaneSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col gap-4 p-4" aria-busy="true">
      <h2 id="page-title" tabIndex={-1} className="sr-only">
        {t('inbox.conversationLoading')}
      </h2>
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
      <div className="flex flex-col gap-3 pt-6">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="ms-auto h-12 w-1/2" />
        <Skeleton className="h-12 w-3/5" />
      </div>
    </div>
  );
}

/** One conversation (board 09): header, ownership, the timeline, the composer and details. */
export function ConversationPane() {
  const { t, i18n } = useTranslation();
  const { tenantId } = useTenant();
  const { conversationId } = useParams({ from: '/_studio/inbox/$conversationId' });
  const navigate = useNavigate();
  const detail = useConversation(conversationId);
  const messages = useMessages(conversationId);
  const drafts = useDrafts(conversationId);
  const [detailsWide, setDetailsWide] = useState(detailsPreference);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetOpener = useOpener(sheetOpen);
  const paneRef = useRef<HTMLDivElement>(null);
  const dir = directionOf(isLocale(i18n.language) ? i18n.language : 'en');
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 80rem)').matches);
  useDocumentTitle(
    detail.data
      ? t('inbox.documentTitle', { name: detail.data.customer.displayName })
      : t('inbox.title'),
  );

  useEffect(() => {
    const query = window.matchMedia('(min-width: 80rem)');
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // Opening a conversation puts focus on its name (screen readers hear which one opened), also
  // when it was still loading and the placeholder that had focus is gone.
  const focusPending = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per opened conversation
  useEffect(() => {
    focusPending.current = true;
  }, [conversationId]);
  const loaded = detail.data !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: also runs when another conversation opens
  useEffect(() => {
    if (!loaded || !focusPending.current) return;
    focusPending.current = false;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        // The page-level move may have landed on the inbox heading while this route loaded.
        const active = document.activeElement;
        if (!active || active === document.body || active.id === 'inbox-heading') {
          document.getElementById('page-title')?.focus();
        }
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [loaded, conversationId]);

  // Colleagues see who is here; the mark expires on its own if this tab goes away.
  useEffect(() => {
    sendPresence(tenantId, conversationId, 'viewing');
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') sendPresence(tenantId, conversationId, 'viewing');
    }, 20_000);
    return () => {
      clearInterval(timer);
      sendPresence(tenantId, conversationId, 'left');
    };
  }, [tenantId, conversationId]);

  const back = () => {
    returnToQueue(conversationId);
    void navigate({ to: '/inbox', search: (prev: InboxSearch) => prev });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.nativeEvent.isComposing) return;
    // Only keys pressed in this pane; dialogs and menus handle their own Escape.
    if (!paneRef.current?.contains(event.target as Node)) return;
    const row = document.querySelector<HTMLElement>(
      `[data-testid="inbox-list"] [data-conversation-id="${conversationId}"] [data-row-link]`,
    );
    event.preventDefault();
    if (row && row.offsetParent !== null) row.focus();
    else back();
  };

  const toggleDetails = () => {
    if (wide) {
      setDetailsWide((value) => {
        try {
          window.localStorage.setItem(DETAILS_KEY, value ? 'hidden' : 'shown');
        } catch {
          // The choice then lasts for this page only.
        }
        return !value;
      });
    } else setSheetOpen(true);
  };

  if (detail.error && detail.data === undefined) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-4">
        <h2 id="page-title" tabIndex={-1} className="text-xl font-semibold text-text">
          {t('inbox.unavailable')}
        </h2>
        {isApiError(detail.error, 'NOT_FOUND') ? (
          <p className="text-sm text-text-secondary">{t('inbox.notFound')}</p>
        ) : (
          <ErrorPanel
            error={detail.error}
            onRetry={() => detail.refetch()}
            retrying={detail.isRefetching}
          />
        )}
        <Button variant="secondary" className="self-start" onClick={back}>
          {t('inbox.back')}
        </Button>
      </div>
    );
  }
  if (!detail.data) return <PaneSkeleton />;
  const data = detail.data;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere in the pane returns to the queue
    <div
      ref={paneRef}
      className="flex min-w-0 flex-1 lg:h-full"
      onKeyDown={onKeyDown}
      data-testid="conversation-pane"
      data-owner-mode={data.ownerMode}
      data-status={data.status}
    >
      <section
        aria-labelledby="page-title"
        className="flex min-w-0 flex-1 flex-col bg-bg lg:h-full lg:overflow-hidden"
      >
        <Header
          detail={data}
          onBack={back}
          detailsOpen={wide ? detailsWide : sheetOpen}
          onToggleDetails={toggleDetails}
        />
        <OwnershipBanner detail={data} />
        <Timeline detail={data} messages={chronological(messages.data)} query={messages} />
        <Composer key={conversationId} detail={data} drafts={drafts} />
      </section>
      {wide && detailsWide ? (
        <aside
          aria-label={t('inbox.details.title')}
          className="hidden w-80 shrink-0 overflow-y-auto border-s border-border bg-surface xl:block"
          data-testid="details-panel"
        >
          <ContextPanel detail={data} />
        </aside>
      ) : null}
      <Sheet open={!wide && sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side={dir === 'rtl' ? 'left' : 'right'}
          showCloseButton={false}
          className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md"
          data-testid="details-sheet"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus(sheetOpener.current);
          }}
        >
          <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-border bg-bg px-4 py-3">
            <div className="flex flex-col">
              <SheetTitle className="text-lg">{t('inbox.details.title')}</SheetTitle>
              <SheetDescription className="text-xs">
                <bdi>{data.customer.displayName}</bdi>
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('app.close')}>
                <XIcon aria-hidden="true" />
              </Button>
            </SheetClose>
          </div>
          <ContextPanel detail={data} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
