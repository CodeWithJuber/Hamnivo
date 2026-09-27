import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/** Sets the tab title to "<page> · Hamnivo Studio". */
export function useDocumentTitle(title: string) {
  const { t } = useTranslation();
  const app = t('app.name');
  useEffect(() => {
    document.title = title ? `${title} · ${app}` : app;
  }, [title, app]);
}

/**
 * The page's one h1. Studio moves focus here after navigating, so screen readers start at the
 * new page's name (see AppShell).
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow}
        <h1 id="page-title" tabIndex={-1} className="text-2xl font-semibold text-text">
          {title}
        </h1>
        {description ? (
          <p className="max-w-prose text-sm text-text-secondary">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A titled region of a page (a landmark named by its heading). */
export function Section({
  id,
  title,
  description,
  actions,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={`flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6 ${className ?? ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`${id}-title`} tabIndex={-1} className="text-lg font-semibold text-text">
            {title}
          </h2>
          {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
