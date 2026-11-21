import { RecoverableError } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { Spinner } from '@hamnivo/ui/components/spinner';
import { type ErrorComponentProps, Link, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { reportError } from '../lib/error-reporting';
import { describeError } from '../lib/errors';
import { useDocumentTitle } from './PageHeader';

/** Shown while a page's code or first data loads. */
export function PagePending() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[40vh] items-center justify-center" aria-busy="true">
      <Spinner className="size-6 text-text-muted" aria-label={t('app.loading')} />
    </div>
  );
}

/** An unexpected failure while loading a page; retry reloads only this route. */
export function PageError({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const text = describeError(t, error);
  useDocumentTitle(t('errors.page.title'));
  // The router caught it, so the page's error event never sees it.
  useEffect(() => reportError(error), [error]);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 sm:p-8">
      <h1 id="page-title" tabIndex={-1} className="text-2xl font-semibold text-text">
        {t('errors.page.title')}
      </h1>
      <RecoverableError
        title={text.title}
        description={text.description}
        retryLabel={t('app.retry')}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
        referenceLabel={t('app.reference')}
        {...(text.reference ? { reference: text.reference } : {})}
      />
    </div>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('states.notFoundTitle'));
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-4 p-4 sm:p-8">
      <h1 id="page-title" tabIndex={-1} className="text-2xl font-semibold text-text">
        {t('states.notFoundTitle')}
      </h1>
      <p className="text-text-secondary">{t('states.notFoundDescription')}</p>
      <Button asChild variant="secondary">
        <Link to="/">{t('states.backToOverview')}</Link>
      </Button>
    </div>
  );
}
