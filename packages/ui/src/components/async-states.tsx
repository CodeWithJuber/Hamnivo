import {
  AlertCircleIcon,
  CloudOffIcon,
  InboxIcon,
  RefreshCwIcon,
  SearchXIcon,
  WifiIcon,
} from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';
import { Button } from './button';

type EmptyStateProps = React.ComponentProps<'section'> & {
  /** "no-records": nothing exists yet. "no-matches": filters/search hide existing records. */
  kind: 'no-records' | 'no-matches';
  title: string;
  description?: string;
  /** The useful next step — required: an empty state without an action is a dead end. */
  action: React.ReactNode;
  icon?: React.ReactNode;
};

/** Genuine empty state that distinguishes "no records" from "no matches" (HNV-24-03). */
function EmptyState({
  kind,
  title,
  description,
  action,
  icon,
  className,
  ...props
}: EmptyStateProps) {
  const Icon = kind === 'no-matches' ? SearchXIcon : InboxIcon;
  return (
    <section
      data-slot="empty-state"
      data-kind={kind}
      aria-label={title}
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-border bg-surface px-6 py-8 text-center',
        className,
      )}
      {...props}
    >
      {icon ?? <Icon className="size-6 text-text-muted" aria-hidden="true" />}
      <div className="flex flex-col gap-1">
        <h3 className="text-md font-semibold text-text">{title}</h3>
        {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
      </div>
      {action}
    </section>
  );
}

type RecoverableErrorProps = React.ComponentProps<'div'> & {
  title: string;
  description: string;
  retryLabel: string;
  onRetry: () => void;
  retrying?: boolean;
  /** Support reference shown so the user can quote it; never an internal stack trace. */
  reference?: string;
  referenceLabel?: string;
};

/** Specific, recoverable error with a retry that repeats only the failing operation (HNV-24-05). */
function RecoverableError({
  title,
  description,
  retryLabel,
  onRetry,
  retrying = false,
  reference,
  referenceLabel = 'Reference',
  className,
  ...props
}: RecoverableErrorProps) {
  return (
    <div
      data-slot="recoverable-error"
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-4',
        className,
      )}
      {...props}
    >
      <AlertCircleIcon className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-semibold text-danger">{title}</p>
        <p className="text-sm text-text">{description}</p>
        {reference ? (
          <p className="text-xs text-text-secondary">
            {referenceLabel}:{' '}
            <bdi dir="ltr" className="font-mono">
              {reference}
            </bdi>
          </p>
        ) : null}
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry} busy={retrying}>
        {retrying ? null : <RefreshCwIcon aria-hidden="true" />}
        {retryLabel}
      </Button>
    </div>
  );
}

type PartialFailureProps = React.ComponentProps<'div'> & {
  succeeded: number;
  failed: number;
  summary: string;
  retryFailedLabel: string;
  onRetryFailed: () => void;
};

/** Partial failure: successful portions stay usable; retry targets only the failed subset. */
function PartialFailure({
  succeeded,
  failed,
  summary,
  retryFailedLabel,
  onRetryFailed,
  className,
  ...props
}: PartialFailureProps) {
  return (
    <div
      data-slot="partial-failure"
      role="status"
      data-succeeded={succeeded}
      data-failed={failed}
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning-subtle p-3',
        className,
      )}
      {...props}
    >
      <AlertCircleIcon className="size-5 shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-text">{summary}</p>
      <Button variant="secondary" size="sm" onClick={onRetryFailed}>
        {retryFailedLabel}
      </Button>
    </div>
  );
}

export type ConnectionState = 'online' | 'reconnecting' | 'offline' | 'degraded';

type ConnectionBannerProps = React.ComponentProps<'div'> & {
  state: ConnectionState;
  message: string;
  /** e.g. "Last synced 10:24". */
  lastSynced?: string;
  retryLabel?: string;
  onRetry?: () => void;
};

/** Honest connectivity banner with last sync time; hidden while online (HNV-06-04, HNV-24-05). */
function ConnectionBanner({
  state,
  message,
  lastSynced,
  retryLabel,
  onRetry,
  className,
  ...props
}: ConnectionBannerProps) {
  if (state === 'online') return null;
  const Icon = state === 'reconnecting' ? WifiIcon : CloudOffIcon;
  return (
    <div
      data-slot="connection-banner"
      data-state={state}
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm',
        state === 'degraded'
          ? 'border-warning/40 bg-warning-subtle'
          : 'border-border bg-surface-sunken',
        className,
      )}
      {...props}
    >
      <Icon
        className={cn('size-4', state === 'reconnecting' && 'animate-pulse')}
        aria-hidden="true"
      />
      <span className="font-medium text-text">{message}</span>
      {lastSynced ? <span className="text-text-secondary">{lastSynced}</span> : null}
      {onRetry && retryLabel ? (
        <Button variant="link" size="sm" className="ms-auto h-auto" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

type LoadingRegionProps = {
  loading: boolean;
  /** Accessible status text while loading, e.g. "Loading conversations". */
  label: string;
  /** Skeleton with the same geometry as the final content. */
  skeleton: React.ReactNode;
  children: React.ReactNode;
  /** After this many ms the region stops showing a skeleton and renders `timedOut` (never loop forever). */
  timeoutMs?: number;
  timedOut?: React.ReactNode;
};

/** Stable-geometry loading region that turns into a retry state after a timeout (HNV-24-03). */
function LoadingRegion({
  loading,
  label,
  skeleton,
  children,
  timeoutMs = 15_000,
  timedOut,
}: LoadingRegionProps) {
  const [expired, setExpired] = React.useState(false);
  React.useEffect(() => {
    if (!loading) {
      setExpired(false);
      return;
    }
    const timer = setTimeout(() => setExpired(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [loading, timeoutMs]);
  if (!loading) return <>{children}</>;
  if (expired && timedOut) return <>{timedOut}</>;
  return (
    <div data-slot="loading-region" aria-busy="true">
      <span role="status" className="sr-only">
        {label}
      </span>
      <div aria-hidden="true">{skeleton}</div>
    </div>
  );
}

export { ConnectionBanner, EmptyState, LoadingRegion, PartialFailure, RecoverableError };
