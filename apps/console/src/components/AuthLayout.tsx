import { HamnivoMark } from '@hamnivo/ui/components/hamnivo-mark';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageSelect, TranslationNote } from './LanguageSelect';
import { useDocumentTitle } from './PageHeader';

/** Board 02: one calm card for signing in, signing up and recovering an account. */
export function AuthLayout({
  title,
  description,
  children,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  useDocumentTitle(title);
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('app.skipToContent')}
      </a>
      <header className="flex items-center justify-between gap-4 px-4 py-4 sm:px-8">
        <span className="flex items-center gap-2">
          <HamnivoMark className="size-7" />
          <span className="text-lg font-semibold text-text">Hamnivo</span>
          <span className="text-sm text-text-secondary">Studio</span>
        </span>
        <LanguageSelect id="auth-language" />
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 items-start justify-center px-4 pb-12 sm:items-center"
      >
        <div
          className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8`}
        >
          <h1 id="page-title" tabIndex={-1} className="text-2xl font-semibold text-text">
            {title}
          </h1>
          {description ? <p className="mt-1 text-sm text-text-secondary">{description}</p> : null}
          <div className="mt-6">{children}</div>
          <TranslationNote className="mt-6 text-xs text-text-secondary" />
        </div>
      </main>
    </div>
  );
}
