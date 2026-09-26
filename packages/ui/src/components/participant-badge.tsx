import { BotIcon, InfoIcon, UserRoundIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../lib/utils';
import { HamnivoMark } from './hamnivo-mark';

export type ParticipantKind =
  | 'customer'
  | 'human_agent'
  | 'supervisor'
  | 'ai_primary'
  | 'ai_specialist'
  | 'guest'
  | 'external_agent'
  | 'system';

export const isAiParticipant = (kind: ParticipantKind) =>
  kind === 'ai_primary' || kind === 'ai_specialist' || kind === 'external_agent';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1
      ? `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}`
      : (parts[0]?.slice(0, 2) ?? '');
  return letters.toUpperCase() || '?';
}

type AvatarProps = { kind: ParticipantKind; name: string; className?: string };

/**
 * Avatar that never lets an AI pass as a person (blueprint W04, U09): AI participants always show
 * the Hamnivo mark or an agent glyph, humans show initials, system notices show an info glyph.
 */
function ParticipantAvatar({ kind, name, className }: AvatarProps) {
  const base =
    'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold';
  if (kind === 'ai_primary') {
    return (
      <span className={cn(base, 'border border-border bg-surface', className)} aria-hidden="true">
        <HamnivoMark className="size-4" />
      </span>
    );
  }
  if (kind === 'ai_specialist' || kind === 'external_agent') {
    return (
      <span className={cn(base, 'bg-info-subtle text-info', className)} aria-hidden="true">
        <BotIcon className="size-4" />
      </span>
    );
  }
  if (kind === 'system') {
    return (
      <span className={cn(base, 'bg-surface-sunken text-text-muted', className)} aria-hidden="true">
        <InfoIcon className="size-4" />
      </span>
    );
  }
  if (kind === 'guest') {
    return (
      <span
        className={cn(base, 'border border-dashed border-input bg-surface text-text', className)}
        aria-hidden="true"
      >
        <UserRoundIcon className="size-4" />
      </span>
    );
  }
  return (
    <span className={cn(base, 'bg-brand-subtle text-text', className)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

type ParticipantBadgeProps = React.ComponentProps<'span'> & {
  kind: ParticipantKind;
  name: string;
  /** Visible role label, e.g. "AI assistant", "Support agent", "Billing specialist (AI)". */
  roleLabel: string;
  showAvatar?: boolean;
};

/** Name plus an explicit, text-labelled role. The role is required so identity never relies on icons alone. */
function ParticipantBadge({
  kind,
  name,
  roleLabel,
  showAvatar = true,
  className,
  ...props
}: ParticipantBadgeProps) {
  return (
    <span
      data-slot="participant-badge"
      data-kind={kind}
      className={cn('inline-flex items-center gap-2', className)}
      {...props}
    >
      {showAvatar ? <ParticipantAvatar kind={kind} name={name} /> : null}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-medium text-text">{name}</span>
        <span
          className={cn(
            'text-xs',
            isAiParticipant(kind) ? 'font-medium text-info' : 'text-text-muted',
          )}
        >
          {roleLabel}
        </span>
      </span>
    </span>
  );
}

export { initials, ParticipantAvatar, ParticipantBadge };
