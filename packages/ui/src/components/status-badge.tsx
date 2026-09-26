import {
  AlertTriangleIcon,
  CheckCheckIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleIcon,
  ClockIcon,
  Loader2Icon,
  OctagonXIcon,
} from 'lucide-react';
import type * as React from 'react';
import { cn } from '../lib/utils';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand';

const toneStyles: Record<StatusTone, string> = {
  neutral: 'bg-surface-sunken text-text-secondary',
  info: 'bg-info-subtle text-info',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  brand: 'bg-brand-subtle text-text',
};

const toneIcons: Record<StatusTone, typeof CircleIcon> = {
  neutral: CircleIcon,
  info: CircleDashedIcon,
  success: CheckIcon,
  warning: AlertTriangleIcon,
  danger: OctagonXIcon,
  brand: CircleIcon,
};

type StatusBadgeProps = React.ComponentProps<'span'> & {
  tone?: StatusTone;
  /** Override the default tone icon; pass `null` only when the label alone is unambiguous. */
  icon?: React.ReactNode | null;
  children: React.ReactNode;
};

/** Status pill with text and icon — status is never communicated by colour alone. */
function StatusBadge({ tone = 'neutral', icon, className, children, ...props }: StatusBadgeProps) {
  const Icon = toneIcons[tone];
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        toneStyles[tone],
        className,
      )}
      {...props}
    >
      {icon === undefined ? <Icon className="size-3.5" aria-hidden="true" /> : icon}
      {children}
    </span>
  );
}

/** Message delivery states (W06): queued locally → accepted by server → delivered → read, or failed. */
export type DeliveryState = 'queued' | 'sending' | 'accepted' | 'delivered' | 'read' | 'failed';

const deliveryIcon: Record<DeliveryState, React.ReactNode> = {
  queued: <ClockIcon className="size-3.5" aria-hidden="true" />,
  sending: <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />,
  accepted: <CheckIcon className="size-3.5" aria-hidden="true" />,
  delivered: <CheckCheckIcon className="size-3.5" aria-hidden="true" />,
  read: <CheckCheckIcon className="size-3.5 text-success" aria-hidden="true" />,
  failed: <OctagonXIcon className="size-3.5 text-danger" aria-hidden="true" />,
};

type DeliveryStatusProps = React.ComponentProps<'span'> & {
  state: DeliveryState;
  /** Localized label, e.g. "Sent", "Delivered", "Not sent — tap to retry". */
  label: string;
};

/** Compact delivery indicator for a message bubble; the label is always present for assistive tech. */
function DeliveryStatus({ state, label, className, ...props }: DeliveryStatusProps) {
  return (
    <span
      data-slot="delivery-status"
      data-state={state}
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        state === 'failed' ? 'text-danger' : 'text-text-muted',
        className,
      )}
      {...props}
    >
      {deliveryIcon[state]}
      <span>{label}</span>
    </span>
  );
}

/** Outcome of a consequential action (G14, X10). "unknown" is explicit, never shown as success. */
export type ActionOutcome =
  | 'requested'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export const actionOutcomeTone: Record<ActionOutcome, StatusTone> = {
  requested: 'neutral',
  awaiting_approval: 'warning',
  approved: 'info',
  executing: 'info',
  completed: 'success',
  failed: 'danger',
  unknown: 'warning',
  cancelled: 'neutral',
};

function ActionOutcomeBadge({
  outcome,
  label,
  ...props
}: { outcome: ActionOutcome; label: string } & Omit<StatusBadgeProps, 'tone' | 'children'>) {
  const icon =
    outcome === 'unknown' ? (
      <CircleHelpIcon className="size-3.5" aria-hidden="true" />
    ) : outcome === 'executing' ? (
      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
    ) : undefined;
  return (
    <StatusBadge tone={actionOutcomeTone[outcome]} icon={icon} data-outcome={outcome} {...props}>
      {label}
    </StatusBadge>
  );
}

export { ActionOutcomeBadge, DeliveryStatus, StatusBadge };
