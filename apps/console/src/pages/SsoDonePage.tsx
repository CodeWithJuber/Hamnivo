import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/AuthLayout';
import { reauth } from '../lib/reauth';
import { rememberSignInMethod, SSO_DONE_MESSAGE } from '../lib/sso';

/**
 * The end of single sign-on (A13). In the small sign-in-again window it tells Studio underneath
 * and closes; after a full-page sign-in it continues to where the person was going.
 */
export function SsoDonePage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/sso/done' });
  const router = useRouter();
  const client = useQueryClient();

  useEffect(() => {
    if (!search.error) rememberSignInMethod('sso');
    const opener = window.opener as Window | null;
    if (opener && opener !== window) {
      opener.postMessage(
        { type: SSO_DONE_MESSAGE, ...(search.error ? { error: search.error } : {}) },
        window.location.origin,
      );
      window.close();
      return;
    }
    if (search.error) {
      void router.navigate({ to: '/sign-in', search: { error: search.error } });
      return;
    }
    reauth.resume();
    client.clear();
    void router.navigate({ href: search.next ?? '/overview', replace: true });
  }, [search.error, search.next, router, client]);

  return (
    <AuthLayout title={t('sso.continue')}>
      <p role="status" className="text-sm text-text-secondary">
        {t('sso.done')}
      </p>
    </AuthLayout>
  );
}
