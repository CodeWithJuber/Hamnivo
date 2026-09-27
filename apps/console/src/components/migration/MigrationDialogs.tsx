import { Button } from '@hamnivo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@hamnivo/ui/components/field';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { Input } from '@hamnivo/ui/components/input';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, newIdempotencyKey } from '../../lib/api';
import { readBase64 } from '../../lib/files';
import { formatBytes } from '../../lib/format';
import {
  ACCEPTED_EXPORTS,
  acceptedExport,
  type ImportSource,
  MIGRATION_MAX_BYTES,
  type MigrationJob,
  migrationKeys,
  useMigrationSources,
} from '../../lib/migration';
import { useBrandRefs } from '../../lib/names';
import { useStudioMutation } from '../../lib/queries';
import { AppDialog, DialogFooter } from '../AppDialog';
import { ChoiceField, describedBy, SelectField, TextField } from '../Fields';
import { ActionError } from '../States';

type NewSource = ImportSource | 'chatwoot';

const isNewSource = (system: string): system is NewSource =>
  system === 'tawk.to' || system === 'hamnivo' || system === 'chatwoot';

type CreateBody =
  | { brandId: string; source: ImportSource; file: { name: string; base64: string } }
  | {
      brandId: string;
      source: 'chatwoot';
      connection: { baseUrl: string; accountId: number; apiToken: string; inboxIds?: number[] };
    };

/**
 * Step 1 (HNV-18-01): the brand to import into and the source: an export file (tawk.to or a
 * Hamnivo package), or another Chatwoot account read with an access token (M04).
 */
export function NewImportDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (job: MigrationJob) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const brands = useBrandRefs();
  const sources = useMigrationSources();
  const [brandId, setBrandId] = useState('');
  const [source, setSource] = useState<NewSource>('tawk.to');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [accountId, setAccountId] = useState('');
  const [token, setToken] = useState('');
  const [inboxes, setInboxes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [reading, setReading] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const activeBrands = (brands.items ?? []).filter((b) => b.status === 'active');

  useEffect(() => {
    if (!open) return;
    setBrandId('');
    setSource('tawk.to');
    setFile(null);
    setUrl('');
    setAccountId('');
    setToken('');
    setInboxes('');
    setErrors({});
    setAttempted(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const create = useStudioMutation(
    (body: CreateBody, tenant) =>
      api<MigrationJob>('/v1/admin/migrations', { method: 'POST', body, tenant, idempotencyKey }),
    [migrationKeys.all],
  );

  const fileError = (candidate: File | null): string | undefined => {
    if (!candidate) return t('migration.upload.fileRequired');
    if (!acceptedExport(candidate)) return t('migration.upload.fileType');
    if (candidate.size > MIGRATION_MAX_BYTES) {
      return t('migration.upload.fileTooLarge', { size: formatBytes(candidate.size) });
    }
    return undefined;
  };

  const chosenBrand = brandId || (activeBrands.length === 1 ? (activeBrands[0]?.id ?? '') : '');
  const inboxIds = inboxes
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!chosenBrand) next.brand = t('migration.upload.brandRequired');
    if (source === 'chatwoot') {
      if (!/^https?:\/\/\S+$/i.test(url.trim()))
        next.url = t('migration.upload.chatwoot.urlRequired');
      if (!/^\d{1,10}$/.test(accountId.trim()) || Number(accountId) < 1) {
        next.account = t('migration.upload.chatwoot.accountInvalid');
      }
      if (token.trim().length < 8) next.token = t('migration.upload.chatwoot.tokenRequired');
      if (inboxIds.some((id) => !/^\d{1,10}$/.test(id) || Number(id) < 1)) {
        next.inboxes = t('migration.upload.chatwoot.inboxesInvalid');
      }
    } else {
      const problem = fileError(file);
      if (problem) next.file = problem;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    let body: CreateBody;
    if (source === 'chatwoot') {
      body = {
        brandId: chosenBrand,
        source,
        connection: {
          baseUrl: url.trim(),
          accountId: Number(accountId),
          apiToken: token.trim(),
          ...(inboxIds.length > 0 ? { inboxIds: inboxIds.map(Number) } : {}),
        },
      };
    } else {
      if (!file) return;
      setReading(true);
      try {
        body = {
          brandId: chosenBrand,
          source,
          file: { name: file.name, base64: await readBase64(file) },
        };
      } finally {
        setReading(false);
      }
    }
    try {
      const job = await create.mutateAsync(body);
      // The token never stays in the page once it was sent.
      setToken('');
      announce(t('migration.upload.uploaded', { name: job.label }));
      onCreated(job);
      onOpenChange(false);
    } catch {
      // Shown below the form.
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `import-${field}`, message }))
    : [];
  const busy = reading || create.isPending;
  // The sources this server can import from (all three until the list has loaded).
  const systems = (sources.data?.items ?? [])
    .filter((s) => s.available)
    .map((s) => s.system)
    .filter(isNewSource);
  const choices = (
    systems.length > 0 ? systems : (['tawk.to', 'hamnivo', 'chatwoot'] as const)
  ).map((system) => ({
    value: system,
    label: t(`migration.sources.${system}`),
    hint: t(`migration.upload.sourceHints.${system}`),
  }));

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={t('migration.upload.title')}
      description={t('migration.upload.description')}
      testId="new-import-dialog"
      className="sm:max-w-xl"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        {brands.items && activeBrands.length === 0 ? (
          <p className="text-sm text-text-secondary" data-testid="import-no-brands">
            {t('migration.noBrands')}
          </p>
        ) : null}
        <SelectField
          id="import-brand"
          label={t('migration.upload.brand')}
          value={chosenBrand}
          onChange={(event) => setBrandId(event.target.value)}
          placeholder={t('stopAi.choose')}
          options={activeBrands.map((b) => ({ value: b.id, label: b.name }))}
          error={errors.brand}
        />
        <ChoiceField
          id="import-source"
          legend={t('migration.upload.source')}
          value={source}
          onValueChange={(value) => {
            setSource(value as NewSource);
            setErrors({});
          }}
          choices={choices}
        />
        {source === 'chatwoot' ? (
          <div className="flex flex-col gap-4" data-testid="chatwoot-source">
            <TextField
              id="import-url"
              label={t('migration.upload.chatwoot.url')}
              hint={t('migration.upload.chatwoot.urlHint')}
              type="url"
              dir="ltr"
              autoComplete="off"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              error={errors.url}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id="import-account"
                label={t('migration.upload.chatwoot.account')}
                hint={t('migration.upload.chatwoot.accountHint')}
                inputMode="numeric"
                dir="ltr"
                autoComplete="off"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                error={errors.account}
              />
              <TextField
                id="import-inboxes"
                label={t('migration.upload.chatwoot.inboxes')}
                hint={t('migration.upload.chatwoot.inboxesHint')}
                labelNote={t('app.optional')}
                dir="ltr"
                autoComplete="off"
                value={inboxes}
                onChange={(event) => setInboxes(event.target.value)}
                error={errors.inboxes}
              />
            </div>
            <TextField
              id="import-token"
              label={t('migration.upload.chatwoot.token')}
              hint={t('migration.upload.chatwoot.tokenHint')}
              type="password"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              error={errors.token}
            />
          </div>
        ) : (
          <Field data-invalid={errors.file ? true : undefined} className="gap-2">
            <FieldLabel htmlFor="import-file">{t('migration.upload.file')}</FieldLabel>
            <Input
              id="import-file"
              type="file"
              accept={ACCEPTED_EXPORTS}
              aria-invalid={errors.file ? true : undefined}
              aria-describedby={describedBy('import-file', true, errors.file)}
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                // Say at once if the file can't be sent, before anything is uploaded.
                if (chosen) {
                  const problem = fileError(chosen);
                  setErrors((current) => {
                    const { file: _removed, ...rest } = current;
                    return problem ? { ...rest, file: problem } : rest;
                  });
                }
              }}
            />
            <FieldDescription id="import-file-hint">
              {file && !errors.file
                ? t('migration.upload.fileChosen', {
                    name: file.name,
                    size: formatBytes(file.size),
                  })
                : t('migration.upload.fileHint')}
            </FieldDescription>
            {errors.file ? <FieldError id="import-file-error">{errors.file}</FieldError> : null}
          </Field>
        )}
        <p className="text-sm text-text-secondary">{t('migration.upload.privacy')}</p>
        <ActionError error={create.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={busy}>
            {source === 'chatwoot'
              ? t('migration.upload.chatwoot.submit')
              : t('migration.upload.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** Export (M02): a brand's history as a Hamnivo package, prepared in the background. */
export function ExportDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (job: MigrationJob) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const brands = useBrandRefs();
  const [brandId, setBrandId] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const activeBrands = (brands.items ?? []).filter((b) => b.status === 'active');
  const chosenBrand = brandId || (activeBrands.length === 1 ? (activeBrands[0]?.id ?? '') : '');

  useEffect(() => {
    if (!open) return;
    setBrandId('');
    setError(undefined);
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const start = useStudioMutation(
    (body: { brandId: string }, tenant) =>
      api<MigrationJob>('/v1/admin/migrations/exports', {
        method: 'POST',
        body,
        tenant,
        idempotencyKey,
      }),
    [migrationKeys.all],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosenBrand) {
      setError(t('migration.upload.brandRequired'));
      return;
    }
    setError(undefined);
    try {
      const job = await start.mutateAsync({ brandId: chosenBrand });
      announce(t('migration.export.queued'));
      onCreated(job);
      onOpenChange(false);
    } catch {
      // Shown below the form.
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!start.isPending) onOpenChange(next);
      }}
      title={t('migration.export.title')}
      description={t('migration.export.description')}
      testId="export-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <SelectField
          id="export-brand"
          label={t('migration.export.brand')}
          value={chosenBrand}
          onChange={(event) => setBrandId(event.target.value)}
          placeholder={t('stopAi.choose')}
          options={activeBrands.map((b) => ({ value: b.id, label: b.name }))}
          error={error}
        />
        <ActionError error={start.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={start.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={start.isPending}>
            {t('migration.export.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}
