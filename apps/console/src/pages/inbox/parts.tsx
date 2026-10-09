import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import i18next from 'i18next';
import {
  BadgeCheckIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronsUpIcon,
  ChevronUpIcon,
  CircleDotIcon,
  ClockIcon,
  EqualIcon,
  GlobeIcon,
  HandIcon,
  HourglassIcon,
  type LucideIcon,
  MailIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  MoonIcon,
  PauseIcon,
  PhoneIcon,
  SendIcon,
  TicketIcon,
  UserRoundIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { InboxConversation, TicketPriority, TicketState } from '../../lib/inbox';
import { useTenant } from '../../lib/tenant';

const TICKET_TONES: Record<TicketState, StatusTone> = {
  open: 'info',
  pending: 'warning',
  closed: 'success',
};
const TICKET_ICONS = { open: CircleDotIcon, pending: HourglassIcon, closed: CheckCircle2Icon };

/** Where a ticket stands, in words and with an icon (never colour alone). */
export function TicketStateBadge({ state }: { state: TicketState }) {
  const { t } = useTranslation();
  const Icon = TICKET_ICONS[state];
  return (
    <StatusBadge
      tone={TICKET_TONES[state]}
      icon={<Icon className="size-3.5" aria-hidden="true" />}
      data-ticket-state={state}
    >
      {t(`inbox.tickets.stateBadge.${state}`)}
    </StatusBadge>
  );
}

/** A ticket's reference as people quote it: "#1042", with a ticket icon and its name for readers. */
export function TicketReference({ reference }: { reference: string }) {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium text-text"
      data-testid="ticket-reference"
    >
      <TicketIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('inbox.tickets.reference', { reference })}</span>
      <bdi dir="ltr" aria-hidden="true">
        {reference}
      </bdi>
    </span>
  );
}

const PRIORITY_TONES: Record<TicketPriority, StatusTone> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};
const PRIORITY_ICONS = {
  urgent: ChevronsUpIcon,
  high: ChevronUpIcon,
  medium: EqualIcon,
  low: ChevronDownIcon,
};

/** How urgent a conversation is, in words and with an icon (never colour alone). */
export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const { t } = useTranslation();
  const Icon = PRIORITY_ICONS[priority];
  return (
    <StatusBadge
      tone={PRIORITY_TONES[priority]}
      icon={<Icon className="size-3.5" aria-hidden="true" />}
      data-priority={priority}
    >
      {t(`inbox.tickets.priorityBadge.${priority}`)}
    </StatusBadge>
  );
}

const locale = () => i18next.resolvedLanguage ?? i18next.language ?? 'en';

/** "10:24" today, "Mon" this week, "27 Sep" before that: short enough for a queue row. */
export function shortTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(date);
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short' }).format(date);
}

/** How long something has waited, as "5 min", "3 hr" or "2 days" in the interface language. */
export function formatWaited(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  const [value, unit]: [number, 'minute' | 'hour' | 'day'] =
    minutes < 60
      ? [minutes, 'minute']
      : minutes < 48 * 60
        ? [Math.round(minutes / 60), 'hour']
        : [Math.round(minutes / 1440), 'day'];
  return new Intl.NumberFormat(locale(), {
    style: 'unit',
    unit,
    unitDisplay: unit === 'day' ? 'long' : 'short',
  }).format(value);
}

export function timeOfDay(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

export function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'full' }).format(new Date(iso));
}

/** A language tag in the interface language ("Arabic"), or the tag itself when unknown. */
export function languageName(tag: string | null | undefined): string | null {
  if (!tag) return null;
  try {
    return new Intl.DisplayNames([locale()], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The signed-in staff member's id in this workspace. */
export function useMyStaffId(): string | null {
  const { me } = useTenant();
  return me.current?.staffMemberId ?? null;
}

/** Who answers the conversation now, in words and with an icon (never colour alone). */
export function OwnerBadge({ conversation }: { conversation: InboxConversation }) {
  const { t } = useTranslation();
  const me = useMyStaffId();
  const { owner, ownerMode } = conversation;
  if (ownerMode === 'AI_ACTIVE') {
    return (
      <StatusBadge tone="info" icon={<BotIcon className="size-3.5" aria-hidden="true" />}>
        {t('inbox.owner.ai')}
      </StatusBadge>
    );
  }
  if (ownerMode === 'WAITING_HUMAN') {
    return (
      <StatusBadge tone="warning" icon={<HandIcon className="size-3.5" aria-hidden="true" />}>
        {conversation.waitingSince
          ? t('inbox.owner.waitingFor', { time: formatWaited(conversation.waitingSince) })
          : t('inbox.owner.waiting')}
      </StatusBadge>
    );
  }
  if (ownerMode === 'PAUSED') {
    return (
      <StatusBadge tone="warning" icon={<PauseIcon className="size-3.5" aria-hidden="true" />}>
        {t('inbox.owner.paused')}
      </StatusBadge>
    );
  }
  const name =
    owner.kind === 'staff'
      ? owner.staffMemberId === me
        ? t('inbox.owner.you')
        : owner.displayName
      : owner.kind === 'external'
        ? t('inbox.owner.external')
        : t('inbox.owner.person');
  return (
    <StatusBadge tone="brand" icon={<UserRoundIcon className="size-3.5" aria-hidden="true" />}>
      <bdi>{name}</bdi>
    </StatusBadge>
  );
}

export function ConversationStatusBadge({
  status,
  snoozedUntil,
}: {
  status: InboxConversation['status'];
  snoozedUntil?: string | null;
}) {
  const { t } = useTranslation();
  if (status === 'resolved') {
    return (
      <StatusBadge
        tone="success"
        icon={<CheckCircle2Icon className="size-3.5" aria-hidden="true" />}
        data-status={status}
      >
        {t('inbox.status.resolved')}
      </StatusBadge>
    );
  }
  if (status === 'snoozed') {
    return (
      <StatusBadge
        tone="neutral"
        icon={<MoonIcon className="size-3.5" aria-hidden="true" />}
        data-status={status}
      >
        {snoozedUntil
          ? t('inbox.status.snoozedUntil', { time: shortTime(snoozedUntil) })
          : t('inbox.status.snoozed')}
      </StatusBadge>
    );
  }
  return (
    <StatusBadge
      tone="neutral"
      icon={<ClockIcon className="size-3.5" aria-hidden="true" />}
      data-status={status}
    >
      {t(`inbox.status.${status}`)}
    </StatusBadge>
  );
}

export function IdentityBadge({ identity }: { identity: 'verified' | 'anonymous' | 'unknown' }) {
  const { t } = useTranslation();
  if (identity === 'verified') {
    return (
      <StatusBadge
        tone="success"
        icon={<BadgeCheckIcon className="size-3.5" aria-hidden="true" />}
        data-identity={identity}
      >
        {t('inbox.identity.verified')}
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="neutral" data-identity={identity}>
      {t(`inbox.identity.${identity}`)}
    </StatusBadge>
  );
}

const CHANNEL_ICONS: Record<InboxConversation['channel'], LucideIcon> = {
  chat: MessageCircleIcon,
  email: MailIcon,
  whatsapp: MessageSquareIcon,
  telegram: SendIcon,
  sms: PhoneIcon,
  other: GlobeIcon,
};

/** Channel as an icon with its name for assistive technology (and a tooltip-free text fallback). */
export function ChannelIcon({ channel }: { channel: InboxConversation['channel'] }) {
  const { t } = useTranslation();
  const Icon = CHANNEL_ICONS[channel];
  return (
    <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{t(`inbox.channel.${channel}`)}</span>
    </span>
  );
}
