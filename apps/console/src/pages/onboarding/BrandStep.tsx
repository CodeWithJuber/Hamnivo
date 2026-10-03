import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import { api, newIdempotencyKey } from '../../lib/api';
import { keys, useStudioMutation, useWorkspaces } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import type { Brand } from '../../lib/types';
import { parseWebsites } from '../BrandsPage';

/**
 * What a person types for "your website" as an address the chat may load on: `noor.example`,
 * `https://noor.example/shop` and `https://noor.example/` all become `https://noor.example`.
 * Nothing is returned for an empty box; `invalid` says what could not be read.
 */
export function websiteOf(input: string): { origin: string | null; invalid: string | null } {
  const text = input.trim();
  if (!text) return { origin: null, invalid: null };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return { origin: null, invalid: text };
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
      return { origin: null, invalid: text };
    }
    // The gateway wants a bare address: a path is the website's business, not the chat's.
    const parsed = parseWebsites(url.origin);
    return parsed.origins[0]
      ? { origin: parsed.origins[0], invalid: null }
      : { origin: null, invalid: text };
  } catch {
    return { origin: null, invalid: text };
  }
}

/**
 * Step 2: the brand and its website. A workspace that already has brands carries on with one of
 * them; a new one is made here with the website it will load on.
 */
export function BrandStep({
  brands,
  chosenId,
  onChoose,
  onDone,
}: {
  brands: readonly Brand[];
  chosenId: string | undefined;
  onChoose: (brandId: string) => void;
  /** The brand to set up, once there is one. */
  onDone: (brandId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const workspaces = useWorkspaces();
  const [adding, setAdding] = useState(brands.length === 0);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const area = workspaces.data?.items.find((w) => w.status === 'active');

  const create = useStudioMutation(
    (body: { workspaceId: string; name: string; allowedOrigins: string[] }, tenant) =>
      api<Brand>('/v1/admin/brands', { method: 'POST', body, tenant, idempotencyKey }),
    [keys.brands, keys.workspaces],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('brands.nameRequired');
    const site = websiteOf(website);
    if (site.invalid !== null) {
      next.website = t('setup.onboarding.brand.websiteInvalid', { value: site.invalid });
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || !area) return;
    try {
      const brand = await create.mutateAsync({
        workspaceId: area.id,
        name: name.trim(),
        allowedOrigins: site.origin ? [site.origin] : [],
      });
      announce(t('brands.created', { name: brand.name }));
      // A second tap must not make a second brand.
      setIdempotencyKey(newIdempotencyKey());
      await onDone(brand.id);
    } catch {
      // Shown below the form.
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({
        fieldId: `onb-brand-${field}`,
        message,
      }))
    : [];

  if (!adding && brands.length > 0) {
    const chosen = brands.find((brand) => brand.id === chosenId) ?? brands[0];
    return (
      <div className="flex flex-col gap-4" data-testid="onboarding-brand-existing">
        <SelectField
          id="onb-brand-existing"
          label={t('setup.onboarding.brand.existing')}
          hint={t('setup.onboarding.brand.existingHint')}
          value={chosen?.id ?? ''}
          onChange={(event) => onChoose(event.target.value)}
          options={brands.map((brand) => ({ value: brand.id, label: brand.name }))}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => chosen && void onDone(chosen.id)}>
            {t('setup.onboarding.brand.use', { name: chosen?.name ?? '' })}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
            {t('setup.onboarding.brand.addAnother')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex max-w-xl flex-col gap-5"
      onSubmit={submit}
      noValidate
      data-testid="onboarding-brand-form"
    >
      <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
      <TextField
        id="onb-brand-name"
        label={t('brands.name')}
        hint={t('brands.nameHint')}
        value={name}
        maxLength={80}
        autoComplete="organization"
        onChange={(event) => setName(event.target.value)}
        error={errors.name}
      />
      <TextField
        id="onb-brand-website"
        label={t('setup.onboarding.brand.website')}
        hint={t('setup.onboarding.brand.websiteHint')}
        labelNote={t('app.optional')}
        value={website}
        type="text"
        inputMode="url"
        dir="ltr"
        spellCheck={false}
        autoComplete="url"
        placeholder="https://northline.example"
        onChange={(event) => setWebsite(event.target.value)}
        error={errors.website}
      />
      <ActionError error={workspaces.error ?? (isCancelled(create.error) ? null : create.error)} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" busy={create.isPending} disabled={!area}>
          {t('setup.onboarding.brand.create')}
        </Button>
        {brands.length > 0 ? (
          <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
            {t('setup.onboarding.brand.useExisting')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
