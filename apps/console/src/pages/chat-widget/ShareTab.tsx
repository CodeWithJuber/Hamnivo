import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, ExternalLinkIcon, InfoIcon, QrCodeIcon } from 'lucide-react';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { encode } from 'uqr';
import { CopyButton } from '../../components/CopyButton';
import { CheckboxField, TextField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { DOCS } from '../../lib/docs';
import { installSnippet } from '../../lib/install';
import type { BrandRef } from '../../lib/names';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import {
  type DirectLinkView,
  useDirectLink,
  useSaveDirectLink,
  widgetFormKeys,
} from '../../lib/widget-forms';
import { LeaveGuard } from '../settings/DiscardChangesDialog';

/**
 * A QR code for a link, as SVG: one path of dark squares on a white square, so it scans in print
 * whatever colours Studio is in. Medium error correction survives a scuffed sticker.
 */
export function qrSvg(url: string): { size: number; path: string; svg: string } {
  const { size, data } = encode(url, { ecc: 'M', border: 2 });
  let path = '';
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#FFFFFF"/><path d="${path}" fill="#000000"/></svg>`;
  return { size, path, svg };
}

/** "noor-books" from "Noor Books", for a file name. */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'chat';

function QrCode({ url, name }: { url: string; name: string }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const qr = useMemo(() => qrSvg(url), [url]);
  const download = () => {
    const href = URL.createObjectURL(new Blob([qr.svg], { type: 'image/svg+xml' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = `chat-link-${slug(name)}.svg`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 0);
    announce(t('chatWidget.share.qr.downloaded'));
  };
  return (
    <div className="flex flex-col items-start gap-3">
      <svg
        role="img"
        aria-label={t('chatWidget.share.qr.label', { name })}
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shapeRendering="crispEdges"
        className="size-56 rounded-md border border-border"
        data-testid="direct-link-qr"
      >
        <rect width={qr.size} height={qr.size} fill="#FFFFFF" />
        <path d={qr.path} fill="#000000" />
      </svg>
      <Button type="button" variant="secondary" onClick={download} data-testid="download-qr">
        <DownloadIcon aria-hidden="true" />
        {t('chatWidget.share.qr.download')}
      </Button>
    </div>
  );
}

function DirectLinkEditor({ brand, view }: { brand: BrandRef; view: DirectLinkView }) {
  const { t } = useTranslation();
  const { can, tenantId } = useTenant();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const save = useSaveDirectLink(brand.id);
  const [enabled, setEnabled] = useState(view.enabled);
  const urlRef = useRef<HTMLInputElement>(null);
  const editable = can('widget.configure');
  const dirty = enabled !== view.enabled;
  const live = view.enabled && view.url ? view.url : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await save.mutateAsync({ enabled });
      // What was saved is the new starting point at once, without waiting for a reload.
      client.setQueryData([tenantId, ...widgetFormKeys.directLink(brand.id)], result);
      announce(
        result.enabled
          ? t('chatWidget.share.link.savedOn', { name: brand.name })
          : t('chatWidget.share.link.savedOff', { name: brand.name }),
      );
    } catch {
      // Shown below the form.
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <LeaveGuard dirty={dirty} />
      <Section
        id="direct-link"
        title={t('chatWidget.share.link.title')}
        description={t('chatWidget.share.link.description')}
        actions={
          <GuideLink href={DOCS.setup.directLink}>{t('chatWidget.share.link.guide')}</GuideLink>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={submit}
          noValidate
          data-testid="direct-link-form"
        >
          <CheckboxField
            id="direct-link-enabled"
            label={t('chatWidget.share.link.enabled')}
            hint={t('chatWidget.share.link.enabledHint')}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <ActionError error={isCancelled(save.error) ? null : save.error} />
          {isCancelled(save.error) ? (
            <p role="status" className="text-sm text-text-secondary">
              {t('app.cancelled')}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <ReasonedAction reason={editable ? null : t('chatWidget.noPermission')}>
              <Button type="submit" busy={save.isPending} disabled={!dirty}>
                {t('chatWidget.share.link.save')}
              </Button>
            </ReasonedAction>
            {dirty ? (
              <span className="text-sm text-text-secondary" data-testid="direct-link-unsaved">
                {t('chatWidget.unsaved')}
              </span>
            ) : null}
          </div>
        </form>
        {live ? (
          <div className="flex flex-col gap-3" data-testid="direct-link-live">
            <TextField
              ref={urlRef}
              id="direct-link-url"
              label={t('chatWidget.share.link.url')}
              value={live}
              readOnly
              dir="ltr"
              spellCheck={false}
              onFocus={(event) => event.target.select()}
            />
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton
                text={live}
                label={t('chatWidget.share.link.copy')}
                copiedLabel={t('chatWidget.share.link.copied')}
                failedLabel={t('chatWidget.share.link.copyFailed')}
                selectTarget={() => {
                  urlRef.current?.select();
                  return null;
                }}
                testId="copy-direct-link"
              />
              <Button asChild variant="secondary" size="sm">
                <a
                  href={live}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('chatWidget.share.link.openLabel')}
                  data-testid="open-direct-link"
                >
                  <ExternalLinkIcon aria-hidden="true" />
                  {t('chatWidget.share.link.open')}
                </a>
              </Button>
            </div>
          </div>
        ) : (
          <p
            className="flex items-start gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text"
            data-testid="direct-link-off"
          >
            <InfoIcon className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <span>
              {view.enabled ? t('chatWidget.share.link.noUrl') : t('chatWidget.share.link.off')}
            </span>
          </p>
        )}
        <p className="text-sm text-text-secondary">{t('chatWidget.share.link.anyWebsite')}</p>
      </Section>
      <section
        aria-labelledby="direct-link-qr-title"
        className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6 lg:sticky lg:top-20 lg:self-start"
      >
        <h2 id="direct-link-qr-title" className="text-lg font-semibold text-text">
          {t('chatWidget.share.qr.title')}
        </h2>
        <p className="text-sm text-text-secondary">{t('chatWidget.share.qr.description')}</p>
        {live ? (
          <QrCode url={live} name={brand.name} />
        ) : (
          <p
            className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary"
            data-testid="direct-link-qr-off"
          >
            <QrCodeIcon className="size-8 text-text-muted" aria-hidden="true" />
            {t('chatWidget.share.qr.off')}
          </p>
        )}
      </section>
    </div>
  );
}

/** The install code, with the widget ID the direct link's settings carry. */
function InstallCode({ widgetId, loading }: { widgetId: string | null; loading: boolean }) {
  const { t } = useTranslation();
  const codeRef = useRef<HTMLElement>(null);
  const snippet = widgetId ? installSnippet(widgetId) : null;
  return (
    <Section
      id="install"
      title={t('brands.install.title')}
      description={t('brands.install.description')}
      actions={
        <GuideLink href={DOCS.integration('html')}>
          {t('chatWidget.share.install.guides')}
        </GuideLink>
      }
    >
      {snippet ? (
        <>
          {/* The snippet wraps (see .hv-code), so it never needs scrolling to be read. */}
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
          <p className="text-xs text-text-secondary">{t('brands.install.note')}</p>
        </>
      ) : loading ? null : (
        <p className="text-sm text-text-secondary" data-testid="install-no-access">
          {t('chatWidget.share.install.noAccess')}
        </p>
      )}
    </Section>
  );
}

/** Sharing the chat: the direct link with its QR code (W28), and the install code. */
export function ShareTab({ brand }: { brand: BrandRef }) {
  const { t } = useTranslation();
  const link = useDirectLink(brand.id);
  return (
    <div className="flex flex-col gap-6" data-testid="share-tab">
      <QueryState query={link} label={t('chatWidget.loading')}>
        {(view) => (
          <DirectLinkEditor
            key={`${brand.id}-${view.configVersion}-${String(view.enabled)}`}
            brand={brand}
            view={view}
          />
        )}
      </QueryState>
      <InstallCode widgetId={link.data?.widgetId ?? null} loading={link.isPending} />
    </div>
  );
}
