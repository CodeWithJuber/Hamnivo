import type { HamnivoClient } from '@hamnivo/client';
import type { MessagePart } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { FileTextIcon, ImageIcon, MapPinIcon, PhoneIcon, UserIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BidiText } from './BidiText.js';

// The larger view of a picture loads when a visitor first opens one.
const Lightbox = lazy(() => import('./Lightbox.js'));

type Part<T extends MessagePart['type']> = Extract<MessagePart, { type: T }>;

const PICTURES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 1.2 MB, 340 KB: sizes in the visitor's language. */
export function fileSize(bytes: number, locale: string): string {
  const format = (value: number, unit: 'kilobyte' | 'megabyte') =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: 1,
    }).format(value);
  return bytes >= 1024 * 1024
    ? format(bytes / (1024 * 1024), 'megabyte')
    : format(Math.max(1, Math.round(bytes / 1024)), 'kilobyte');
}

/** Saves a downloaded file through a temporary link (nothing is shown or run). */
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * A picture sent in the conversation (W09). Its bytes come through the gateway with the session,
 * which checks them again; the preview is a local copy, released when it is no longer shown.
 */
function Picture({
  client,
  conversationId,
  part,
}: {
  client: HamnivoClient;
  conversationId: string;
  part: Part<'attachment'>;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    client
      .downloadAttachment(conversationId, part.uploadId)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [client, conversationId, part.uploadId]);
  const label = t('surface.files.picture', { name: part.name });
  if (failed) {
    return (
      <p className="text-xs text-text-muted" data-testid="file-failed">
        {label} · {t('surface.files.loadFailed')}
      </p>
    );
  }
  return url ? (
    <>
      {/* At least 44 px, so even a tiny picture leaves a button a finger can hit (WCAG 2.5.8). */}
      <span
        className="relative inline-flex min-h-11 min-w-11 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface"
        data-testid="file-picture"
      >
        <img src={url} alt={label} className="block max-h-48 max-w-full object-contain" />
        {/* The picture keeps its own name; the button over it opens it larger. */}
        <button
          type="button"
          className="absolute inset-0 cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          aria-label={t('ui.view', { name: part.name })}
          onClick={() => setOpen(true)}
        />
      </span>
      {open ? (
        <Suspense fallback={null}>
          <Lightbox
            url={url}
            name={part.name}
            label={label}
            closeLabel={t('ui.closeView')}
            downloadLabel={t('surface.files.download', { name: part.name })}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  ) : (
    <span
      className="flex h-24 w-32 items-center justify-center rounded-lg border border-border bg-surface-sunken"
      role="img"
      aria-label={label}
    >
      <ImageIcon className="size-5 text-text-muted" aria-hidden="true" />
    </span>
  );
}

function Download({
  client,
  conversationId,
  part,
  locale,
}: {
  client: HamnivoClient;
  conversationId: string;
  part: Part<'attachment'>;
  locale: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async () => {
    setBusy(true);
    setFailed(false);
    try {
      save(await client.downloadAttachment(conversationId, part.uploadId), part.name);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-auto min-h-10 max-w-full justify-start gap-2 whitespace-normal py-1.5 text-start"
        busy={busy}
        aria-label={t('surface.files.download', { name: part.name })}
        onClick={() => void download()}
        data-testid="file-download"
      >
        <FileTextIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-all">
          <BidiText text={part.name} />
          <span className="ms-1 text-text-muted">· {fileSize(part.sizeBytes, locale)}</span>
        </span>
      </Button>
      {failed ? (
        <span role="alert" className="text-xs text-danger">
          {t('surface.files.loadFailed')}
        </span>
      ) : null}
    </span>
  );
}

/** Files in a message: pictures shown, other files offered for download, refused ones named. */
export function Files({
  client,
  conversationId,
  parts,
  locale,
}: {
  client: HamnivoClient;
  conversationId: string;
  parts: Part<'attachment'>[];
  locale: string;
}) {
  const { t } = useTranslation();
  if (parts.length === 0) return null;
  return (
    <ul className="flex max-w-[85%] flex-col gap-2" data-testid="message-files">
      {parts.map((part) => (
        <li key={part.uploadId}>
          {part.status === 'rejected' ? (
            <span className="text-xs text-text-muted">
              <BidiText text={part.name} /> · {t('surface.files.refused')}
              {part.rejectionReason
                ? ` · ${t(`surface.files.reasons.${part.rejectionReason}`)}`
                : ''}
            </span>
          ) : PICTURES.has(part.mimeType) ? (
            <Picture client={client} conversationId={conversationId} part={part} />
          ) : (
            <Download client={client} conversationId={conversationId} part={part} locale={locale} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** A shared place (W24): its name and coordinates, opened in a map only when asked. */
export function Place({ part }: { part: Part<'location'> }) {
  const { t } = useTranslation();
  const coordinates = `${part.latitude.toFixed(5)}, ${part.longitude.toFixed(5)}`;
  const map = `https://www.openstreetmap.org/?mlat=${part.latitude}&mlon=${part.longitude}#map=16/${part.latitude}/${part.longitude}`;
  return (
    <div
      className="flex max-w-[85%] flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2 text-sm"
      data-testid="part-location"
    >
      <p className="flex items-center gap-2 font-medium text-text">
        <MapPinIcon className="size-4 shrink-0" aria-hidden="true" />
        {t('surface.parts.place')}
      </p>
      {part.label ? <BidiText text={part.label} /> : null}
      <span className="text-xs text-text-muted" dir="ltr">
        {coordinates}
      </span>
      <a
        href={map}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-link underline underline-offset-2"
      >
        {t('surface.parts.openMap')}
      </a>
    </div>
  );
}

/** A shared contact (W24): name, and phone and email links when they are valid. */
export function Contact({ part }: { part: Part<'contact'> }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex max-w-[85%] flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2 text-sm"
      data-testid="part-contact"
    >
      <p className="flex items-center gap-2 font-medium text-text">
        <UserIcon className="size-4 shrink-0" aria-hidden="true" />
        {t('surface.parts.contact')}
      </p>
      <BidiText text={part.name} />
      {part.phone ? (
        <a
          href={`tel:${part.phone.replace(/[^\d+]/g, '')}`}
          className="flex items-center gap-1 text-link underline underline-offset-2"
          aria-label={t('surface.parts.call', { phone: part.phone })}
        >
          <PhoneIcon className="size-3.5" aria-hidden="true" />
          <span dir="ltr">{part.phone}</span>
        </a>
      ) : null}
      {part.email ? (
        <a
          href={`mailto:${part.email}`}
          className="text-link underline underline-offset-2"
          aria-label={t('surface.parts.email', { email: part.email })}
        >
          <span dir="ltr">{part.email}</span>
        </a>
      ) : null}
    </div>
  );
}

/** Anything this widget does not know yet, shown as its text (W24). */
export function Unknown({ part }: { part: Part<'unknown'> }) {
  const { t } = useTranslation();
  return (
    <p
      className="max-w-[85%] rounded-xl border border-dashed border-border px-3 py-2 text-sm text-text-muted"
      data-testid="part-unknown"
    >
      {part.fallbackText ? <BidiText text={part.fallbackText} /> : t('surface.parts.unsupported')}
    </p>
  );
}
