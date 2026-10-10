import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { CircleCheckIcon, GlobeIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatRelative } from '../lib/format';
import { useBrandInstalls } from '../lib/queries';
import type { Brand, BrandInstall } from '../lib/types';

/** Where this brand's chat was seen, most recent first (the gateway keeps only allowed websites). */
export function installsOf(
  items: readonly BrandInstall[] | undefined,
  brandId: string,
): BrandInstall[] {
  return (items ?? []).filter((item) => item.brandId === brandId);
}

/**
 * Whether the brand's chat code is running on its website (HNV-01-03, HNV-01-04), for the install
 * step. While nothing has been seen it says what to do, looks again every few seconds and offers
 * help; once a page there loads the chat it turns green by itself and names the website and when
 * it was last seen. The change is announced to screen readers.
 */
export function InstallStatus({ brand }: { brand: Pick<Brand, 'id' | 'allowedOrigins'> }) {
  const { t } = useTranslation();
  const installs = useBrandInstalls({ waitFor: brand.id });
  const seen = installsOf(installs.data?.items, brand.id);
  const found = seen.length > 0;

  return (
    <section
      aria-labelledby="install-status-title"
      data-testid="install-status"
      data-state={found ? 'found' : 'waiting'}
      className={
        found
          ? 'flex flex-col gap-2 rounded-lg border border-success/40 bg-success-subtle p-4 text-sm'
          : 'flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-4 text-sm'
      }
    >
      <div role="status" className="flex items-start gap-2">
        {found ? (
          <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <LoaderCircleIcon
            className="mt-0.5 size-5 shrink-0 animate-spin text-text-muted motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        <h3 id="install-status-title" className="font-semibold text-text">
          {found
            ? t('setup.onboarding.install.status.found')
            : t('setup.onboarding.install.status.waiting')}
        </h3>
      </div>
      {found ? (
        <>
          <ul className="flex flex-col gap-1">
            {seen.map((install) => (
              <li key={install.origin} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <GlobeIcon className="size-3.5 text-text-muted" aria-hidden="true" />
                <bdi dir="ltr" className="font-medium text-text">
                  {install.origin}
                </bdi>
                <span className="text-text-secondary">
                  {t('setup.onboarding.install.status.lastSeen', {
                    time: formatRelative(install.lastSeenAt),
                  })}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-text-secondary">{t('setup.onboarding.install.status.foundBody')}</p>
        </>
      ) : (
        <>
          <p className="text-text-secondary">{t('setup.onboarding.install.status.waitingBody')}</p>
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              busy={installs.isFetching}
              onClick={() => void installs.refetch()}
              data-testid="install-check"
            >
              <RefreshCwIcon aria-hidden="true" />
              {t('setup.onboarding.install.status.check')}
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer font-medium text-text">
              {t('setup.onboarding.install.status.help')}
            </summary>
            <ul className="mt-2 flex list-disc flex-col gap-1 ps-5 text-text-secondary">
              <li>{t('setup.onboarding.install.status.helpExact')}</li>
              <li>{t('setup.onboarding.install.status.helpCache')}</li>
              <li>{t('setup.onboarding.install.status.helpPolicy')}</li>
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

/**
 * A brand's install state in one badge, under an "On your website" label: when its chat was last
 * seen there, or that it has not been seen yet.
 */
export function InstallBadge({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const installs = useBrandInstalls();
  if (!installs.data) return <span className="text-xs text-text-muted">—</span>;
  const latest = installsOf(installs.data.items, brandId)[0];
  return latest ? (
    <StatusBadge tone="success" data-status="installed" title={latest.origin}>
      {formatRelative(latest.lastSeenAt)}
    </StatusBadge>
  ) : (
    <StatusBadge tone="neutral" data-status="not-seen">
      {t('setup.onboarding.install.status.notSeen')}
    </StatusBadge>
  );
}
