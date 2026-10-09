import { ExternalLinkIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** A link to a written guide; it opens in a new tab, and says so with its icon. */
export function GuideLink({
  href,
  children,
  testId,
}: {
  href: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-link underline underline-offset-4 hover:no-underline"
    >
      {children}
      <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
  );
}
