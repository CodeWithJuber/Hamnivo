import { createFileRoute } from '@tanstack/react-router';
import { safeRedirect } from '../lib/redirects';
import { SsoDonePage } from '../pages/SsoDonePage';

export interface SsoDoneSearch {
  next?: string;
  error?: string;
}

/** Where the gateway sends the browser after single sign-on, in a window or the page itself. */
export const Route = createFileRoute('/sso/done')({
  validateSearch: (search: Record<string, unknown>): SsoDoneSearch => {
    const next = safeRedirect(search.next);
    return {
      ...(next ? { next } : {}),
      ...(typeof search.error === 'string' && /^[a-z_]{1,60}$/.test(search.error)
        ? { error: search.error }
        : {}),
    };
  },
  component: SsoDonePage,
});
