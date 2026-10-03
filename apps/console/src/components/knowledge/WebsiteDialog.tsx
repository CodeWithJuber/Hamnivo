import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { aiPowerKeys, type KnowledgeWebSource } from '../../lib/ai-power';
import { api, newIdempotencyKey } from '../../lib/api';
import { useBrandRefs } from '../../lib/names';
import { keys, useStudioMutation } from '../../lib/queries';
import type { KnowledgeVisibility } from '../../lib/types';
import { AppDialog, DialogFooter } from '../AppDialog';
import { ChoiceField, SelectField, TextField } from '../Fields';
import { ActionError } from '../States';

const HTTP_URL = /^https?:\/\/\S+$/i;
const SCHEDULES = ['daily', 'weekly', 'manual'] as const;
const WHOLE = /^\d+$/;

/** Whole number in a range, as typed; null when it is not one. */
function inRange(text: string, min: number, max: number): number | null {
  const value = text.trim();
  if (!WHOLE.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

/**
 * Add a website as a knowledge source, or change what a website reads and how often. The address
 * and who sees its answers are fixed once it is added (a different address is a different website).
 */
export function WebsiteDialog({
  open,
  onOpenChange,
  web,
  defaultBrandId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Changing this website's settings; adding a new one when absent. */
  web?: KnowledgeWebSource | undefined;
  defaultBrandId?: string | undefined;
  onSaved?: (web: KnowledgeWebSource) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const brands = useBrandRefs();
  const [brandId, setBrandId] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<KnowledgeWebSource['mode']>('site');
  const [maxPages, setMaxPages] = useState('50');
  const [maxDepth, setMaxDepth] = useState('2');
  const [schedule, setSchedule] = useState<KnowledgeWebSource['schedule']>('weekly');
  const [visibility, setVisibility] = useState<KnowledgeVisibility>('public');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setBrandId(web?.brandId ?? defaultBrandId ?? '');
    setUrl(web?.url ?? '');
    setName('');
    setMode(web?.mode ?? 'site');
    setMaxPages(String(web?.maxPages ?? 50));
    setMaxDepth(String(web?.maxDepth ?? 2));
    setSchedule(web?.schedule ?? 'weekly');
    setVisibility(web?.visibility ?? 'public');
    setErrors({});
    setAttempted(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open, web, defaultBrandId]);

  const save = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      web
        ? api<KnowledgeWebSource>(`/v1/admin/knowledge/web-sources/${web.id}`, {
            method: 'PATCH',
            body,
            tenant,
          })
        : api<KnowledgeWebSource>('/v1/admin/knowledge/web-sources', {
            method: 'POST',
            body,
            tenant,
            idempotencyKey,
          }),
    [aiPowerKeys.webSources, keys.sources],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!web) {
      if (!brandId) next.brand = t('agents.createForm.brandRequired');
      if (!url.trim()) next.url = t('aiPower.web.dialog.urlRequired');
      else if (!HTTP_URL.test(url.trim())) next.url = t('aiPower.web.dialog.urlInvalid');
    }
    const pages = inRange(maxPages, 1, 500);
    const depth = inRange(maxDepth, 0, 5);
    if (mode === 'site') {
      if (pages === null) next.pages = t('aiPower.web.dialog.maxPagesInvalid');
      if (depth === null) next.depth = t('aiPower.web.dialog.maxDepthInvalid');
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    // In page mode the limits are not used, so what is stored stays what it was.
    const limits = {
      mode,
      maxPages: pages ?? web?.maxPages ?? 50,
      maxDepth: depth ?? web?.maxDepth ?? 2,
      schedule,
    };
    const body = web
      ? limits
      : {
          brandId,
          url: url.trim(),
          ...limits,
          visibility,
          ...(name.trim() ? { name: name.trim() } : {}),
        };
    try {
      const saved = await save.mutateAsync(body);
      announce(
        web ? t('aiPower.web.dialog.saved') : t('aiPower.web.dialog.added', { name: saved.name }),
      );
      onSaved?.(saved);
      onOpenChange(false);
    } catch {
      // Shown below the form.
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `website-${field}`, message }))
    : [];

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
      }}
      title={web ? t('aiPower.web.dialog.editTitle') : t('aiPower.web.dialog.addTitle')}
      description={web ? undefined : t('aiPower.web.dialog.addDescription')}
      testId="website-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        {web ? null : (
          <>
            <SelectField
              id="website-brand"
              label={t('aiPower.web.dialog.brand')}
              value={brandId}
              onChange={(event) => setBrandId(event.target.value)}
              placeholder={t('stopAi.choose')}
              options={(brands.items ?? []).map((b) => ({ value: b.id, label: b.name }))}
              error={errors.brand}
            />
            <TextField
              id="website-url"
              label={t('aiPower.web.dialog.url')}
              hint={t('aiPower.web.dialog.urlHint')}
              type="url"
              inputMode="url"
              dir="ltr"
              autoComplete="off"
              placeholder="https://example.com/help/"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              error={errors.url}
            />
            <TextField
              id="website-name"
              label={t('aiPower.web.dialog.name')}
              hint={t('aiPower.web.dialog.nameHint')}
              labelNote={t('app.optional')}
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </>
        )}
        <ChoiceField
          id="website-mode"
          legend={t('aiPower.web.dialog.mode')}
          value={mode}
          onValueChange={(value) => setMode(value as KnowledgeWebSource['mode'])}
          choices={[
            {
              value: 'site',
              label: t('aiPower.web.dialog.modeSite'),
              hint: t('aiPower.web.dialog.modeSiteHint'),
            },
            {
              value: 'page',
              label: t('aiPower.web.dialog.modePage'),
              hint: t('aiPower.web.dialog.modePageHint'),
            },
          ]}
        />
        {mode === 'site' ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id="website-pages"
              label={t('aiPower.web.dialog.maxPages')}
              hint={t('aiPower.web.dialog.maxPagesHint')}
              inputMode="numeric"
              value={maxPages}
              onChange={(event) => setMaxPages(event.target.value)}
              error={errors.pages}
            />
            <TextField
              id="website-depth"
              label={t('aiPower.web.dialog.maxDepth')}
              hint={t('aiPower.web.dialog.maxDepthHint')}
              inputMode="numeric"
              value={maxDepth}
              onChange={(event) => setMaxDepth(event.target.value)}
              error={errors.depth}
            />
          </div>
        ) : null}
        <SelectField
          id="website-schedule"
          label={t('aiPower.web.dialog.schedule')}
          value={schedule}
          onChange={(event) => setSchedule(event.target.value as KnowledgeWebSource['schedule'])}
          options={SCHEDULES.map((value) => ({
            value,
            label: t(`aiPower.web.schedule.${value}`),
          }))}
        />
        {web ? null : (
          <ChoiceField
            id="website-visibility"
            legend={t('aiPower.web.dialog.visibility')}
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
        )}
        {web ? null : (
          <p className="text-sm text-text-secondary">{t('aiPower.web.dialog.later')}</p>
        )}
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
            {web ? t('aiPower.web.dialog.save') : t('aiPower.web.dialog.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}
