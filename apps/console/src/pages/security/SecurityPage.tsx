import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';
import { Forbidden } from '../../components/States';
import { useTenant } from '../../lib/tenant';
import { SsoSection } from './SsoSection';
import { SupportSection } from './SupportSection';

/** Workspace security (boards 02 and 26): single sign-on and support access. */
export function SecurityPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const allowed = can('security.manage') || can('support.grant');
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<p className="text-sm text-text-secondary">{t('access.settings')}</p>}
        title={t('access.security.title')}
        description={t('access.security.description')}
      />
      {allowed ? (
        <>
          <SsoSection />
          <SupportSection />
        </>
      ) : (
        <Forbidden />
      )}
    </div>
  );
}
