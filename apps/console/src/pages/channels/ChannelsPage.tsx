import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { Label } from '@hamnivo/ui/components/label';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { Switch } from '@hamnivo/ui/components/switch';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  InboxIcon,
  KeyRoundIcon,
  type LucideIcon,
  MailIcon,
  MailPlusIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SendIcon,
  SettingsIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/AppDialog';
import { BrandPicker, useChosenBrand } from '../../components/BrandPicker';
import { SelectField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { PageHeader } from '../../components/PageHeader';
import { Forbidden, QueryState } from '../../components/States';
import { useTeams } from '../../lib/access';
import { isApiError } from '../../lib/api';
import {
  type ChannelChange,
  type ChannelInbox,
  type ChannelKind,
  type ChannelStatus,
  orderChannels,
  teamsForBrand,
  useChannels,
  useFindChannels,
  useUpdateChannel,
} from '../../lib/channels';
import { DOCS } from '../../lib/docs';
import { formatDateTime, formatRelative } from '../../lib/format';
import type { BrandRef } from '../../lib/names';
import { useBrands, useWorkspaces } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { Team } from '../../lib/types';
import type { ChannelsSearch } from '../../routes/_studio/channels';
import { ChannelProblem, SavedNote } from './ChannelNotes';
import { ConnectEmailDialog, EmailSettingsDialog } from './EmailDialogs';

const KIND_ICONS: Record<ChannelKind, LucideIcon> = {
  email: MailIcon,
  whatsapp: MessageSquareIcon,
  telegram: SendIcon,
  other: InboxIcon,
};

const STATUS_TONES: Record<ChannelStatus, StatusTone> = {
  connected: 'success',
  needs_attention: 'warning',
  paused: 'neutral',
};

const CARD = 'flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6';

/** "Connected", "Needs attention", "Paused": always an icon with the words. */
function StatusChip({ status }: { status: ChannelStatus }) {
  const { t } = useTranslation();
  return (
    <StatusBadge
      tone={STATUS_TONES[status]}
      data-testid="channel-status"
      data-status={status}
      {...(status === 'paused'
        ? { icon: <PauseIcon className="size-3.5" aria-hidden="true" /> }
        : {})}
    >
      {t(`channels.status.${status}`)}
    </StatusBadge>
  );
}

/** The channel's kind as an icon and its name, above the inbox's own name. */
function KindLine({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <p className="flex items-center gap-1.5 text-sm text-text-secondary" data-testid="channel-kind">
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </p>
  );
}

/** The brand's website chat: always there, set up on the Chat widget page. */
function WebChatCard({ brand }: { brand: BrandRef }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  return (
    <li className={CARD} aria-labelledby="channel-web-title" data-testid="web-chat-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <KindLine icon={MessageCircleIcon} label={t('channels.kind.web')} />
          <h2 id="channel-web-title" className="text-lg font-semibold text-text">
            {t('channels.kind.web')}
          </h2>
          <p className="text-sm text-text-secondary">{t('channels.web.text')}</p>
        </div>
        <StatusChip status="connected" />
      </div>
      {can('widget.configure') ? (
        <div>
          <Button asChild variant="secondary" size="sm">
            <Link to="/chat-widget" search={{ brand: brand.id }}>
              <SettingsIcon aria-hidden="true" />
              {t('channels.web.link')}
            </Link>
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** One email, WhatsApp or Telegram inbox, with its switch, team and pause. Each change saves. */
function ChannelCard({
  channel,
  brand,
  teams,
}: {
  channel: ChannelInbox;
  brand: BrandRef;
  teams: readonly Team[];
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const update = useUpdateChannel(brand.id, channel.id);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [pausing, setPausing] = useState(false);
  /** Email settings: closed, open, or open to fix the sign-in (incoming password ready). */
  const [settings, setSettings] = useState<'closed' | 'open' | 'fix'>('closed');
  const id = `channel-${channel.id}`;
  const titleId = `${id}-title`;
  const name = channel.name;
  const claimed = channel.brandId !== null;
  const paused = channel.status === 'paused';
  const mailbox = channel.kind === 'email' && claimed;
  const openSettings = (mode: 'open' | 'fix') => {
    setNote(null);
    setProblem(null);
    setSettings(mode);
  };

  /** Saves one change; says what it did, or keeps the problem next to the card. */
  const save = async (change: ChannelChange, done: string) => {
    setNote(null);
    setProblem(null);
    try {
      await update.mutateAsync(change);
      setNote(done);
      announce(done);
    } catch (error) {
      if (!isCancelled(error)) setProblem(error);
      throw error;
    }
  };
  const quietly = (change: ChannelChange, done: string) =>
    void save(change, done).catch(() => undefined);

  const teamOptions = teams.map((team) => ({ value: team.id, label: team.name }));
  if (channel.defaultTeamId && !teams.some((team) => team.id === channel.defaultTeamId)) {
    teamOptions.push({ value: channel.defaultTeamId, label: t('channels.team.hidden') });
  }
  const teamError = isApiError(problem)
    ? problem.fields.find((field) => field.path === 'defaultTeamId')?.message
    : undefined;

  return (
    <li
      className={CARD}
      aria-labelledby={titleId}
      aria-busy={update.isPending || undefined}
      data-testid="channel-card"
      data-channel={channel.id}
      data-kind={channel.kind}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <KindLine icon={KIND_ICONS[channel.kind]} label={t(`channels.kind.${channel.kind}`)} />
          <h2 id={titleId} className="text-lg font-semibold text-text">
            <bdi>{name}</bdi>
          </h2>
          {channel.address ? (
            <p className="text-sm text-text" data-testid="channel-address">
              <bdi dir="ltr" className="font-mono break-all select-all">
                {channel.address}
              </bdi>
            </p>
          ) : null}
        </div>
        <StatusChip status={channel.status} />
      </div>
      {channel.status === 'needs_attention' && (channel.problem || mailbox) ? (
        <div className="flex flex-col items-start gap-2">
          {channel.problem ? (
            <p className="text-sm text-text" data-testid="channel-problem">
              <bdi dir="auto">{t('channels.problem', { problem: channel.problem })}</bdi>
            </p>
          ) : null}
          {mailbox ? (
            <Button
              type="button"
              size="sm"
              id={`${id}-fix`}
              aria-label={t('channels.email.fix.label', { name })}
              data-testid="channel-fix-sign-in"
              onClick={() => openSettings('fix')}
            >
              <KeyRoundIcon aria-hidden="true" />
              {t('channels.email.fix.action')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-text-secondary">
        <span data-testid="channel-count">
          {t('channels.conversations', { count: channel.conversationsThisWeek })}
        </span>
        <span data-testid="channel-last">
          {channel.lastEventAt ? (
            <time dateTime={channel.lastEventAt} title={formatDateTime(channel.lastEventAt)}>
              {t('channels.lastMessage', { time: formatRelative(channel.lastEventAt) })}
            </time>
          ) : (
            t('channels.noMessages')
          )}
        </span>
      </p>

      {claimed ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Label id={`${id}-ai-label`} htmlFor={`${id}-ai`}>
                {t('channels.ai.label')}
              </Label>
              <p id={`${id}-ai-hint`} className="text-sm text-text-secondary">
                {t('channels.ai.hint')}
              </p>
            </div>
            <Switch
              id={`${id}-ai`}
              checked={channel.aiAnswers}
              aria-labelledby={`${id}-ai-label ${titleId}`}
              aria-describedby={`${id}-ai-hint`}
              data-testid="channel-ai"
              onCheckedChange={(on) =>
                quietly(
                  { aiAnswers: on },
                  on ? t('channels.ai.on', { name }) : t('channels.ai.off', { name }),
                )
              }
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="w-full sm:max-w-xs">
              <SelectField
                id={`${id}-team`}
                label={t('channels.team.label')}
                value={channel.defaultTeamId ?? ''}
                placeholder={t('channels.team.none')}
                options={teamOptions}
                error={teamError}
                data-testid="channel-team"
                onChange={(event) => {
                  const teamId = event.target.value || null;
                  const team = teamOptions.find((option) => option.value === teamId)?.label;
                  quietly(
                    { defaultTeamId: teamId },
                    teamId && team
                      ? t('channels.team.saved', { name, team })
                      : t('channels.team.cleared', { name }),
                  );
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {mailbox ? (
                <Button
                  type="button"
                  variant="secondary"
                  id={`${id}-email-settings`}
                  aria-label={t('channels.email.settings.label', { name })}
                  data-testid="channel-email-settings"
                  onClick={() => openSettings('open')}
                >
                  <SettingsIcon aria-hidden="true" />
                  {t('channels.email.settings.action')}
                </Button>
              ) : null}
              {paused ? (
                <Button
                  type="button"
                  variant="secondary"
                  id={`${id}-pause-toggle`}
                  aria-label={t('channels.resume.label', { name })}
                  data-testid="channel-resume"
                  onClick={() => quietly({ paused: false }, t('channels.resume.done', { name }))}
                >
                  <PlayIcon aria-hidden="true" />
                  {t('channels.resume.action')}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  id={`${id}-pause-toggle`}
                  aria-label={t('channels.pause.label', { name })}
                  data-testid="channel-pause"
                  onClick={() => setPausing(true)}
                >
                  <PauseIcon aria-hidden="true" />
                  {t('channels.pause.action')}
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-3">
          <p className="text-sm text-text">{t('channels.unclaimed.text')}</p>
          <Button
            type="button"
            busy={update.isPending}
            aria-describedby={titleId}
            data-testid="channel-claim"
            onClick={() =>
              quietly(
                { brandId: brand.id as ChannelChange['brandId'] },
                t('channels.unclaimed.done', { name, brand: brand.name }),
              )
            }
          >
            {t('channels.unclaimed.action')}
          </Button>
        </div>
      )}

      <SavedNote text={note} />
      <ChannelProblem error={problem} />

      {mailbox ? (
        <EmailSettingsDialog
          channel={channel}
          brandId={brand.id}
          open={settings !== 'closed'}
          onOpenChange={(open) => {
            if (!open) setSettings('closed');
          }}
          fixSignIn={settings === 'fix'}
          fallbackFocus={() => document.getElementById(`${id}-email-settings`)}
          onSaved={() => {
            const done = t('channels.email.settings.done');
            setNote(done);
            announce(done);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pausing}
        onOpenChange={setPausing}
        title={t('channels.pause.title', { name })}
        confirmLabel={t('channels.pause.confirm')}
        testId="pause-channel-dialog"
        fallbackFocus={() => document.getElementById(`${id}-pause-toggle`)}
        onConfirm={async () => {
          try {
            await save({ paused: true }, t('channels.pause.done', { name }));
          } catch (error) {
            // Saved, but Chatwoot not updated: the dialog closes and the card says so.
            if (isApiError(error, 'AUTHORITY_UNAVAILABLE')) return;
            setProblem(null);
            throw error;
          }
        }}
      >
        <p>{t('channels.pause.body')}</p>
      </ConfirmDialog>
    </li>
  );
}

/** Teams that can take the brand's conversations, for the Team list. */
function useBrandTeams(brandId: string): Team[] {
  const teams = useTeams();
  const brands = useBrands();
  const workspaces = useWorkspaces();
  const workspaceId =
    brands.data?.items.find((brand) => brand.id === brandId)?.workspaceId ??
    workspaces.data?.items.find((w) => w.brands.some((brand) => brand.id === brandId))?.id;
  return teamsForBrand(teams.data?.items, workspaceId);
}

function BrandChannels({ brand }: { brand: BrandRef }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const list = useChannels(brand.id);
  const find = useFindChannels(brand.id);
  const teams = useBrandTeams(brand.id);
  const [found, setFound] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const check = async () => {
    setFound(null);
    try {
      const { added } = await find.mutateAsync();
      const text =
        added > 0 ? t('channels.check.found', { count: added }) : t('channels.check.none');
      setFound(text);
      announce(text);
    } catch {
      // Shown below the button.
    }
  };
  const checkButton = (variant: 'default' | 'secondary') => (
    <Button
      type="button"
      variant={variant}
      busy={find.isPending}
      data-testid="check-channels"
      onClick={() => void check()}
    >
      <RefreshCwIcon aria-hidden="true" />
      {find.isPending ? t('channels.check.busy') : t('channels.check.action')}
    </Button>
  );
  const connectButton = (testId: string) => (
    <Button
      type="button"
      id={testId}
      data-testid={testId}
      onClick={() => {
        setFound(null);
        setConnecting(true);
      }}
    >
      <MailPlusIcon aria-hidden="true" />
      {t('channels.email.connect.action')}
    </Button>
  );
  const checkResult = (
    <>
      <SavedNote text={found} />
      <ChannelProblem error={find.error} />
    </>
  );
  const connectDialog = (
    <ConnectEmailDialog
      brandId={brand.id}
      teams={teams}
      open={connecting}
      onOpenChange={setConnecting}
      fallbackFocus={() => document.getElementById('connect-email')}
      onConnected={() => {
        const text = t('channels.email.connect.done');
        setFound(text);
        announce(text);
      }}
    />
  );

  return (
    <QueryState query={list} label={t('channels.loading')}>
      {(data) => {
        const items = orderChannels(data.items);
        return (
          <div className="flex flex-col gap-4" data-testid="channels" data-brand={brand.id}>
            {items.length > 0 ? (
              <div className="flex flex-col items-start gap-2">
                <div className="flex flex-wrap gap-2">
                  {connectButton('connect-email')}
                  {checkButton('secondary')}
                </div>
                {checkResult}
              </div>
            ) : null}
            <ul
              className="flex flex-col gap-4"
              aria-label={t('channels.list', { brand: brand.name })}
              data-testid="channel-list"
            >
              <WebChatCard brand={brand} />
              {items.map((channel) => (
                <ChannelCard key={channel.id} channel={channel} brand={brand} teams={teams} />
              ))}
            </ul>
            {items.length === 0 ? (
              <EmptyState
                kind="no-records"
                title={t('channels.empty.title')}
                description={t('channels.empty.description')}
                data-testid="channels-empty"
                action={
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex flex-wrap justify-center gap-2">
                      {connectButton('connect-email-empty')}
                      {checkButton('secondary')}
                    </div>
                    {checkResult}
                  </div>
                }
              />
            ) : null}
            {connectDialog}
          </div>
        );
      }}
    </QueryState>
  );
}

/**
 * Channels of one brand (Settings, ADR 0013): web chat, and the email, WhatsApp and Telegram
 * inboxes of its Chatwoot account. Each says whether it works and how busy it is; the AI can be
 * turned on per channel, new conversations sent to a team, and a channel paused. Every change
 * saves at once.
 */
export function ChannelsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/channels' });
  const navigate = useNavigate({ from: '/channels' });
  const { brands, active, chosen } = useChosenBrand(search.brand);
  const query = {
    data: brands.items,
    error: brands.error,
    isPending: brands.pending,
    isRefetching: brands.isRefetching,
    refetch: brands.refetch,
  };
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('channels.title')} description={t('channels.description')} />
      <GuideLink href={DOCS.setup.channels}>{t('channels.guide')}</GuideLink>
      <QueryState
        query={query}
        label={t('channels.loading')}
        permitted={can('integrations.manage') && brands.permitted}
        forbidden={
          <Forbidden
            title={t('channels.forbidden.title')}
            description={t('channels.forbidden.description')}
          />
        }
        isEmpty={() => active.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('channels.noBrands.title')}
            description={t('channels.noBrands.description')}
            action={
              can('brands.manage') ? (
                <Button asChild>
                  <Link to="/brands">{t('channels.noBrands.action')}</Link>
                </Button>
              ) : undefined
            }
          />
        }
      >
        {() =>
          chosen ? (
            <div className="flex flex-col gap-6">
              <BrandPicker
                id="channels-brand"
                label={t('channels.brand')}
                brands={active}
                value={chosen.id}
                onChange={(brand) =>
                  void navigate({ search: (current: ChannelsSearch) => ({ ...current, brand }) })
                }
              />
              <BrandChannels key={chosen.id} brand={chosen} />
            </div>
          ) : null
        }
      </QueryState>
    </div>
  );
}
