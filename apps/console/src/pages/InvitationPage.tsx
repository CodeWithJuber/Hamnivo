import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { MailCheckIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/AuthLayout';
import { ActionError } from '../components/States';
import { api, isApiError } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { meQuery } from '../lib/queries';
import { reauth } from '../lib/reauth';
import { chooseTenant } from '../lib/tenant';
import type { Membership } from '../lib/types';

/** Joining a workspace from an invitation link (A02, board 22). */
export function InvitationPage() {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const search = useSearch({ from: '/invitations/accept' });
  const router = useRouter();
  const client = useQueryClient();
  const me = useQuery({ ...meQuery(), retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const here = `/invitations/accept${search.token ? `?token=${encodeURIComponent(search.token)}` : ''}`;

  const accept = async () => {
    if (!search.token) return;
    setBusy(true);
    setError(null);
    try {
      const membership = await api<Membership>('/v1/invitations/accept', {
        method: 'POST',
        body: { token: search.token },
      });
      chooseTenant(membership.tenant.id);
      await client.invalidateQueries({ queryKey: ['me'] });
      announce(t('access.invitation.accepted', { name: membership.tenant.name }));
      await router.navigate({ to: '/overview' });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const otherAccount = async () => {
    reauth.pause();
    await authClient.signOut().catch(() => undefined);
    client.clear();
    await router.navigate({ to: '/sign-in', search: { redirect: here } });
  };

  let body: ReactNode;
  if (!search.token) {
    body = (
      <p role="alert" className="text-sm text-danger">
        {t('access.invitation.missing')}
      </p>
    );
  } else if (me.isPending) {
    body = (
      <p aria-busy="true" className="text-sm text-text-secondary">
        {t('app.loading')}
      </p>
    );
  } else if (!me.data) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text">{t('access.invitation.signInFirst')}</p>
        <Button asChild>
          <Link to="/sign-in" search={{ redirect: here }}>
            {t('access.invitation.signIn')}
          </Link>
        </Button>
        <p className="text-sm text-text-secondary">{t('access.invitation.createHint')}</p>
        <Button asChild variant="secondary">
          <Link to="/sign-up">{t('access.invitation.createAccount')}</Link>
        </Button>
      </div>
    );
  } else {
    const invalid = isApiError(error, 'NOT_FOUND');
    const unverified = isApiError(error, 'IDENTITY_REQUIRED');
    body = (
      <div className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-sm text-text">
          <MailCheckIcon className="size-4 text-text-muted" aria-hidden="true" />
          {t('access.invitation.signedInAs', { email: me.data.user.email })}
        </p>
        {invalid ? (
          <p role="alert" className="text-sm text-danger" data-testid="invitation-invalid">
            {t('access.invitation.invalid')}
          </p>
        ) : unverified ? (
          <p role="alert" className="text-sm text-danger">
            {t('access.invitation.unverified')}
          </p>
        ) : (
          <ActionError error={error} />
        )}
        <Button busy={busy} onClick={() => void accept()} data-testid="accept-invitation">
          {t('access.invitation.accept')}
        </Button>
        <Button
          variant="link"
          className="h-auto self-start p-0"
          onClick={() => void otherAccount()}
        >
          {t('access.invitation.otherAccount')}
        </Button>
      </div>
    );
  }

  return (
    <AuthLayout
      title={t('access.invitation.title')}
      description={t('access.invitation.description')}
    >
      {body}
    </AuthLayout>
  );
}
