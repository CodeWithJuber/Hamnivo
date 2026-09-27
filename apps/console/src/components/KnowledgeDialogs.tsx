import { Button } from '@hamnivo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@hamnivo/ui/components/field';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { Input } from '@hamnivo/ui/components/input';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, newIdempotencyKey } from '../lib/api';
import { ACCEPTED_FILES, MAX_UPLOAD_BYTES, mediaTypeOf, readBase64 } from '../lib/files';
import { formatBytes } from '../lib/format';
import { useBrandRefs } from '../lib/names';
import { keys, useStudioMutation } from '../lib/queries';
import type {
  AddDocumentRequest,
  DocumentContent,
  KnowledgeDocument,
  KnowledgeSource,
  KnowledgeVisibility,
} from '../lib/types';
import { AppDialog, DialogFooter } from './AppDialog';
import { ChoiceField, describedBy, SelectField, TextareaField, TextField } from './Fields';
import { ActionError } from './States';

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const HTTP_URL = /^https?:\/\/\S+$/;

/** Add a source (brand, name, who may see answers, review cycle) or change its settings. */
export function SourceDialog({
  open,
  onOpenChange,
  source,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing this source; adding a new one when absent. */
  source?: KnowledgeSource | undefined;
  onSaved?: (source: KnowledgeSource) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const brands = useBrandRefs();
  const [brandId, setBrandId] = useState('');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<KnowledgeVisibility>('public');
  const [review, setReview] = useState('');
  const [status, setStatus] = useState<KnowledgeSource['status']>('active');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setBrandId(source?.brandId ?? '');
    setName(source?.name ?? '');
    setVisibility(source?.visibility ?? 'public');
    setReview(source?.reviewEveryDays ? String(source.reviewEveryDays) : '');
    setStatus(source?.status ?? 'active');
    setErrors({});
    setAttempted(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open, source]);

  const save = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      source
        ? api<KnowledgeSource>(`/v1/admin/knowledge/sources/${source.id}`, {
            method: 'PATCH',
            body,
            tenant,
          })
        : api<KnowledgeSource>('/v1/admin/knowledge/sources', {
            method: 'POST',
            body,
            tenant,
            idempotencyKey,
          }),
    [keys.sources],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!source && !brandId) next.brand = t('agents.createForm.brandRequired');
    if (!name.trim()) next.name = t('knowledge.sourceForm.nameRequired');
    const days = review.trim() ? Number(review.trim()) : null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      next.review = t('knowledge.sourceForm.reviewInvalid');
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body = source
      ? { name: name.trim(), visibility, status, reviewEveryDays: days }
      : {
          brandId,
          name: name.trim(),
          visibility,
          ...(days !== null ? { reviewEveryDays: days } : {}),
        };
    try {
      const saved = await save.mutateAsync(body);
      announce(
        source
          ? t('knowledge.sourceForm.saved')
          : t('knowledge.sourceForm.created', { name: saved.name }),
      );
      onSaved?.(saved);
      onOpenChange(false);
    } catch {
      // Shown below the form.
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `source-${field}`, message }))
    : [];

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
      }}
      title={source ? t('knowledge.sourceForm.editTitle') : t('knowledge.sourceForm.addTitle')}
      testId="source-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        {source ? null : (
          <SelectField
            id="source-brand"
            label={t('knowledge.sourceForm.brand')}
            value={brandId}
            onChange={(event) => setBrandId(event.target.value)}
            placeholder={t('stopAi.choose')}
            options={(brands.items ?? []).map((b) => ({ value: b.id, label: b.name }))}
            error={errors.brand}
          />
        )}
        <TextField
          id="source-name"
          label={t('knowledge.sourceForm.name')}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
        />
        <ChoiceField
          id="source-visibility"
          legend={t('knowledge.sourceForm.visibility')}
          value={visibility}
          onValueChange={(value) => setVisibility(value as KnowledgeVisibility)}
          choices={[
            {
              value: 'public',
              label: t('knowledge.visibility.public'),
              hint: t('knowledge.visibility.publicHint'),
            },
            {
              value: 'internal',
              label: t('knowledge.visibility.internal'),
              hint: t('knowledge.visibility.internalHint'),
            },
          ]}
        />
        <TextField
          id="source-review"
          label={t('knowledge.sourceForm.review')}
          hint={t('knowledge.sourceForm.reviewHint')}
          labelNote={t('app.optional')}
          inputMode="numeric"
          value={review}
          onChange={(event) => setReview(event.target.value)}
          error={errors.review}
        />
        {source ? (
          <SelectField
            id="source-status"
            label={t('knowledge.sourceForm.status')}
            value={status}
            onChange={(event) => setStatus(event.target.value as KnowledgeSource['status'])}
            options={(['active', 'paused', 'retired'] as const).map((value) => ({
              value,
              label: t(`knowledge.sourceStatus.${value}`),
            }))}
          />
        ) : null}
        <ActionError error={save.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={save.isPending}>
            {source ? t('knowledge.sourceForm.save') : t('knowledge.sourceForm.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

type PasteFormat = 'text/markdown' | 'text/plain' | 'text/html';

/**
 * Add a document to a source, or a new version of one: pasted text (Markdown, plain or HTML) or
 * a file (PDF, DOCX, HTML, TXT, MD) sent as base64. The 5 MB limit is checked before sending.
 */
export function UploadDialog({
  open,
  onOpenChange,
  sourceId,
  document,
  onQueued,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceId: string;
  /** Uploading a new version of this document; a new document when absent. */
  document?: KnowledgeDocument | undefined;
  onQueued?: (document: KnowledgeDocument) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [language, setLanguage] = useState('');
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [format, setFormat] = useState<PasteFormat>('text/markdown');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [validUntil, setValidUntil] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [reading, setReading] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setUrl('');
    setLanguage('');
    setMode('paste');
    setFormat('text/markdown');
    setText('');
    setFile(null);
    setValidUntil('');
    setErrors({});
    setAttempted(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const upload = useStudioMutation(
    (body: AddDocumentRequest | { content: DocumentContent }, tenant) =>
      document
        ? api<KnowledgeDocument>(`/v1/admin/knowledge/documents/${document.id}/versions`, {
            method: 'POST',
            body,
            tenant,
            idempotencyKey,
          })
        : api<KnowledgeDocument>(`/v1/admin/knowledge/sources/${sourceId}/documents`, {
            method: 'POST',
            body,
            tenant,
            idempotencyKey,
          }),
    [keys.documents(sourceId), keys.sources],
  );

  const fileError = (candidate: File | null): string | undefined => {
    if (!candidate) return t('knowledge.upload.fileRequired');
    if (!mediaTypeOf(candidate)) return t('knowledge.upload.fileType');
    if (candidate.size > MAX_UPLOAD_BYTES) {
      return t('knowledge.upload.fileTooLarge', { size: formatBytes(candidate.size) });
    }
    return undefined;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!document && !title.trim()) next.title = t('knowledge.upload.titleRequired');
    if (!document && url.trim() && !HTTP_URL.test(url.trim())) {
      next.url = t('knowledge.upload.urlInvalid');
    }
    if (!document && language.trim() && !LANGUAGE_TAG.test(language.trim())) {
      next.language = t('knowledge.upload.languageInvalid');
    }
    if (mode === 'paste' && !text.trim()) next.text = t('knowledge.upload.textRequired');
    if (mode === 'file') {
      const problem = fileError(file);
      if (problem) next.file = problem;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    let content: DocumentContent;
    const until = validUntil
      ? { validUntil: new Date(`${validUntil}T23:59:59`).toISOString() }
      : {};
    if (mode === 'file' && file) {
      setReading(true);
      try {
        content = {
          mediaType: mediaTypeOf(file) ?? 'text/plain',
          base64: await readBase64(file),
          ...until,
        };
      } finally {
        setReading(false);
      }
    } else {
      content = { mediaType: format, text, ...until };
    }
    const body = document
      ? { content }
      : {
          title: title.trim(),
          content,
          ...(url.trim() ? { url: url.trim() } : {}),
          ...(language.trim() ? { language: language.trim() } : {}),
        };
    try {
      const queued = await upload.mutateAsync(body);
      announce(t('knowledge.upload.queued', { title: queued.title }));
      onQueued?.(queued);
      onOpenChange(false);
    } catch {
      // Shown below the form.
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `upload-${field}`, message }))
    : [];
  const busy = reading || upload.isPending;

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={
        document
          ? t('knowledge.upload.versionTitle', { title: document.title })
          : t('knowledge.upload.addTitle')
      }
      testId="upload-dialog"
      className="sm:max-w-2xl"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        {document ? null : (
          <>
            <TextField
              id="upload-title"
              label={t('knowledge.upload.docTitle')}
              value={title}
              maxLength={300}
              onChange={(event) => setTitle(event.target.value)}
              error={errors.title}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id="upload-url"
                label={t('knowledge.upload.url')}
                hint={t('knowledge.upload.urlHint')}
                labelNote={t('app.optional')}
                type="url"
                dir="ltr"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                error={errors.url}
              />
              <TextField
                id="upload-language"
                label={t('knowledge.upload.language')}
                hint={t('knowledge.upload.languageHint')}
                labelNote={t('app.optional')}
                dir="ltr"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                error={errors.language}
              />
            </div>
          </>
        )}
        <ChoiceField
          id="upload-mode"
          legend={t('knowledge.upload.content')}
          value={mode}
          columns
          onValueChange={(value) => setMode(value as 'paste' | 'file')}
          choices={[
            { value: 'paste', label: t('knowledge.upload.paste') },
            { value: 'file', label: t('knowledge.upload.file') },
          ]}
        />
        {mode === 'paste' ? (
          <>
            <SelectField
              id="upload-format"
              label={t('knowledge.upload.format')}
              value={format}
              onChange={(event) => setFormat(event.target.value as PasteFormat)}
              options={[
                { value: 'text/markdown', label: t('knowledge.upload.formats.markdown') },
                { value: 'text/plain', label: t('knowledge.upload.formats.plain') },
                { value: 'text/html', label: t('knowledge.upload.formats.html') },
              ]}
            />
            <TextareaField
              id="upload-text"
              label={t('knowledge.upload.text')}
              value={text}
              rows={8}
              dir="auto"
              onChange={(event) => setText(event.target.value)}
              error={errors.text}
            />
          </>
        ) : (
          <Field data-invalid={errors.file ? true : undefined} className="gap-2">
            <FieldLabel htmlFor="upload-file">{t('knowledge.upload.fileLabel')}</FieldLabel>
            <Input
              id="upload-file"
              type="file"
              accept={ACCEPTED_FILES}
              aria-invalid={errors.file ? true : undefined}
              aria-describedby={describedBy('upload-file', true, errors.file)}
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
            <FieldDescription id="upload-file-hint">
              {file && !errors.file
                ? t('knowledge.upload.fileChosen', {
                    name: file.name,
                    size: formatBytes(file.size),
                  })
                : t('knowledge.upload.fileHint')}
            </FieldDescription>
            {errors.file ? <FieldError id="upload-file-error">{errors.file}</FieldError> : null}
          </Field>
        )}
        <TextField
          id="upload-validUntil"
          label={t('knowledge.upload.validUntil')}
          hint={t('knowledge.upload.validUntilHint')}
          labelNote={t('app.optional')}
          type="date"
          value={validUntil}
          onChange={(event) => setValidUntil(event.target.value)}
        />
        <ActionError error={upload.error} />
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
            {document ? t('knowledge.upload.submitVersion') : t('knowledge.upload.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}
