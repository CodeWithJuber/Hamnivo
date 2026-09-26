import type * as React from 'react';
import { cn } from '../lib/utils';

type ProgressStatusProps = React.ComponentProps<'div'> & {
  label: string;
  /** Completed units; omit for indeterminate work (never fabricate a percentage). */
  value?: number;
  max?: number;
  /** e.g. "Importing 156 of 240 · About 1 minute remaining" — only estimates the backend can justify. */
  detail?: string;
  action?: React.ReactNode;
};

/** Progress with real counts; indeterminate when the total is unknown (blueprint §5 rule 7). */
function ProgressStatus({
  label,
  value,
  max,
  detail,
  action,
  className,
  ...props
}: ProgressStatusProps) {
  const determinate = value !== undefined && max !== undefined && max > 0;
  const ratio = determinate ? Math.min(1, Math.max(0, value / max)) : 0;
  const circumference = 2 * Math.PI * 14;
  return (
    <div
      data-slot="progress-status"
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-surface p-3',
        className,
      )}
      {...props}
    >
      <svg
        viewBox="0 0 32 32"
        className={cn('size-8 shrink-0 -rotate-90', !determinate && 'animate-spin')}
        aria-hidden="true"
      >
        <circle cx="16" cy="16" r="14" fill="none" stroke="var(--hv-border)" strokeWidth="3" />
        <circle
          cx="16"
          cy="16"
          r="14"
          fill="none"
          stroke="var(--hv-accent)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={determinate ? circumference * (1 - ratio) : circumference * 0.75}
        />
      </svg>
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          role="progressbar"
          aria-label={label}
          aria-valuemin={determinate ? 0 : undefined}
          aria-valuemax={determinate ? max : undefined}
          aria-valuenow={determinate ? value : undefined}
          aria-valuetext={detail}
          className="font-medium text-text"
        >
          {label}
        </span>
        {detail ? <span className="text-sm text-text-secondary">{detail}</span> : null}
      </div>
      {action}
    </div>
  );
}

export { ProgressStatus };
