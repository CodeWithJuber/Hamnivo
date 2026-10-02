import { LoadingRegion, RecoverableError } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { Skeleton } from '@hamnivo/ui/components/skeleton';
import { Link } from '@tanstack/react-router';
import { AlertCircleIcon, LockIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isApiError } from '../lib/api';
import { describeError } from '../lib/errors';

/** Permission-denied state: says what is missing and who can help (HNV-02-06, HNV-24-02). */
export function Forbidden({
  title,
  description,
  compact = false,
}: {
  title?: string;
  description?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section
      data-testid="forbidden"
      aria-label={title ?? t('states.forbiddenTitle')}
      className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface px-6 py-8 text-center"
    >
      <LockIcon className="size-6 text-text-muted" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <h3 className="text-md font-semibold text-text">{title ?? t('states.forbiddenTitle')}</h3>
        <p className="text-sm text-text-secondary">
          {description ?? t('states.forbiddenDescription')}
        </p>
      </div>
      {compact ? null : (
        <Button asChild variant="secondary">
          <Link to="/overview">{t('states.backToOverview')}</Link>
        </Button>
      )}
    </section>
  );
}

/** A failed load with a retry that repeats only this request (HNV-24-05). */
export function ErrorPanel({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const { t } = useTranslation();
  if (isApiError(error, 'SCOPE_DENIED')) return <Forbidden compact />;
  const text = describeError(t, error);
  return (
    <RecoverableError
      title={text.title}
      description={text.detail ? `${text.description} ${text.detail}` : text.description}
      retryLabel={t('app.retry')}
      onRetry={onRetry}
      retrying={retrying ?? false}
      referenceLabel={t('app.reference')}
      {...(text.reference ? { reference: text.reference } : {})}
    />
  );
}

/** "You can try again in 20 s", counting down from the gateway's Retry-After. */
function RetryCountdown({ seconds }: { seconds: number }) {
  const { t } = useTranslation();
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const timer = setInterval(() => setLeft((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [seconds]);
  return (
    <p className="text-text" data-testid="retry-countdown">
      {left > 0
        ? t('errors.rateLimited.retryIn', { seconds: left })
        : t('errors.rateLimited.retryNow')}
    </p>
  );
}

/** A failed change, shown next to the form or action that caused it. */
export function ActionError({ error, id }: { error: unknown; id?: string }) {
  const { t } = useTranslation();
  if (!error) return null;
  const text = describeError(t, error);
  return (
    <div
      id={id}
      role="alert"
      data-testid="action-error"
      className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm"
    >
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold text-danger">{text.title}</p>
        <p className="text-text">{text.description}</p>
        {text.detail ? (
          <p className="text-text-secondary">
            <bdi dir="auto">{t('app.serverDetail', { detail: text.detail })}</bdi>
          </p>
        ) : null}
        {isApiError(error, 'RATE_LIMITED') && error.problem?.retryAfter ? (
          <RetryCountdown seconds={error.problem.retryAfter} />
        ) : null}
        {text.reference ? (
          <p className="text-xs text-text-secondary">
            {t('app.reference')}:{' '}
            <bdi dir="ltr" className="font-mono">
              {text.reference}
            </bdi>
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  isRefetching?: boolean;
  refetch: () => unknown;
}

/**
 * Loading, error, permission-denied and empty states for one query, in the same place and
 * geometry as the content they stand for (HNV-24-03).
 */
export function QueryState<T>({
  query,
  label,
  permitted = true,
  forbidden,
  skeleton,
  isEmpty,
  empty,
  children,
}: {
  query: QueryLike<T>;
  label: string;
  permitted?: boolean;
  forbidden?: ReactNode;
  skeleton?: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { t } = useTranslation();
  if (!permitted) return <>{forbidden ?? <Forbidden compact />}</>;
  if (query.error && query.data === undefined) {
    return (
      <ErrorPanel
        error={query.error}
        onRetry={() => query.refetch()}
        retrying={query.isRefetching ?? false}
      />
    );
  }
  if (query.isPending || query.data === undefined) {
    return (
      <LoadingRegion
        loading
        label={label}
        skeleton={skeleton ?? <ListSkeleton />}
        timedOut={
          <RecoverableError
            title={t('errors.network.title')}
            description={t('errors.network.description')}
            retryLabel={t('app.retry')}
            onRetry={() => query.refetch()}
          />
        }
      >
        {null}
      </LoadingRegion>
    );
  }
  if (isEmpty?.(query.data) && empty) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
