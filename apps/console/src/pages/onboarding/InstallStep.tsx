import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon, GlobeIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../../components/CopyButton';
import { SelectField } from '../../components/Fields';
import { InstallStatus } from '../../components/InstallStatus';
import { DOCS } from '../../lib/docs';
import {
  guideSlug,
  installSnippet,
  isPlatform,
  PLATFORMS,
  type PlatformId,
} from '../../lib/install';
import type { Brand } from '../../lib/types';

/**
 * Step 6: put the chat on the website. Pick where the website is built to get that platform's
 * guide, and copy the code. The step then waits for a page of the brand's website to load the
 * chat, and says so as soon as one does (HNV-01-03, HNV-01-04).
 */
export function InstallStep({
  brand,
  onDone,
}: {
  brand: Brand;
  onDone: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<PlatformId>('html');
  const codeRef = useRef<HTMLElement>(null);
  const snippet = installSnippet(brand.widgetId);
  const name = t(`setup.install.platforms.${platform}`);

  return (
    <div className="flex flex-col gap-5" data-testid="onboarding-install">
      <div className="max-w-md">
        <SelectField
          id="onb-platform"
          label={t('setup.onboarding.install.platform')}
          hint={t('setup.onboarding.install.platformHint')}
          value={platform}
          onChange={(event) => {
            if (isPlatform(event.target.value)) setPlatform(event.target.value);
          }}
          options={PLATFORMS.map((p) => ({
            value: p.id,
            label: t(`setup.install.platforms.${p.id}`),
          }))}
        />
      </div>
      <p className="text-sm">
        <a
          href={DOCS.integration(guideSlug(platform))}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="install-guide"
          className="inline-flex items-center gap-1.5 font-medium text-link underline underline-offset-4 hover:no-underline"
        >
          {t('setup.onboarding.install.guide', { platform: name })}
          <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
        </a>
      </p>
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-semibold text-text">{t('brands.install.title')}</h3>
        <pre className="rounded-lg border border-border bg-surface-sunken p-3 text-sm">
          <code ref={codeRef} className="hv-code" data-testid="install-snippet">
            {snippet}
          </code>
        </pre>
        <div>
          <CopyButton
            text={snippet}
            label={t('brands.install.copy')}
            copiedLabel={t('brands.install.copied')}
            failedLabel={t('brands.install.copyFailed')}
            selectTarget={() => codeRef.current}
            testId="copy-snippet"
          />
        </div>
        <details className="rounded-lg border border-border p-3 text-sm">
          <summary className="cursor-pointer font-medium text-text">
            {t('setup.onboarding.install.where')}
          </summary>
          <p className="mt-3 text-text-secondary">{t('setup.onboarding.install.whereBody')}</p>
        </details>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text">{t('brands.allowed')}</h3>
        {brand.allowedOrigins.length === 0 ? (
          <p className="text-sm text-warning" data-testid="install-no-websites">
            {t('brands.noWebsites')}{' '}
            <Link
              to="/brands"
              hash={`brand-${brand.id}`}
              className="underline underline-offset-4 hover:no-underline"
            >
              {t('setup.onboarding.install.addWebsite')}
            </Link>
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {brand.allowedOrigins.map((origin) => (
              <li
                key={origin}
                className="inline-flex items-center gap-1.5 rounded-md bg-surface-sunken px-2 py-1 text-sm"
              >
                <GlobeIcon className="size-3.5 text-text-muted" aria-hidden="true" />
                <bdi dir="ltr">{origin}</bdi>
              </li>
            ))}
          </ul>
        )}
      </div>
      {brand.allowedOrigins.length > 0 ? <InstallStatus brand={brand} /> : null}
      <div>
        <Button type="button" onClick={() => void onDone()}>
          {t('setup.onboarding.install.done')}
        </Button>
      </div>
    </div>
  );
}
