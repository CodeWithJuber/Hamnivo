import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../../components/AppDialog';
import { BrandPicker, useChosenBrand } from '../../components/BrandPicker';
import { ChoiceField, SelectField, TextareaField, TextField } from '../../components/Fields';
import { PageHeader, Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { api, isApiError, newIdempotencyKey } from '../../lib/api';
import { DOCS } from '../../lib/docs';
import { formatDateTime } from '../../lib/format';
import {
  type CreatedIdentityKey,
  type IdentityKey,
  identityKeysKey,
  isKeyName,
  PUBLIC_ALGORITHMS,
  type PublicAlgorithm,
  parseJwk,
  useIdentityKeys,
} from '../../lib/identity';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import { SecretReveal } from '../developer/SecretReveal';

type Kind = 'secret' | 'public';

const statusTone = { active: 'success', retiring: 'warning', revoked: 'neutral' } as const;

interface Created {
  key: CreatedIdentityKey;
  /** The key that was replaced could not be set to retire; the person is told to do it. */
  retireFailed: boolean;
}

export function CreateKeyDialog({
  brandId,
  open,
  replacing,
  onOpenChange,
  onCreated,
}: {
  brandId: string;
  open: boolean;
  /** A key being replaced: the new one is of the same type, and the old one is retired after. */
  replacing: IdentityKey | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: Created) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('secret');
  const [alg, setAlg] = useState<PublicAlgorithm>('ES256');
  const [name, setName] = useState('');
  const [jwk, setJwk] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    const publicAlg = replacing && replacing.alg !== 'HS256' ? replacing.alg : null;
    setKind(replacing ? (publicAlg ? 'public' : 'secret') : 'secret');
    setAlg(publicAlg ?? 'ES256');
    setName('');
    setJwk('');
    setErrors({});
    setAttempted(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open, replacing]);

  const create = useStudioMutation(
    async (
      body: { alg: string; kid?: string; publicJwk?: Record<string, unknown> },
      tenant,
    ): Promise<Created> => {
      const key = await api<CreatedIdentityKey>(`/v1/admin/brands/${brandId}/identity-keys`, {
        method: 'POST',
        tenant,
        body,
        idempotencyKey,
      });
      if (!replacing) return { key, retireFailed: false };
      try {
        await api<IdentityKey>(
          `/v1/admin/brands/${brandId}/identity-keys/${encodeURIComponent(replacing.kid)}/retire`,
          { method: 'POST', tenant },
        );
        return { key, retireFailed: false };
      } catch {
        // The new key exists, and its secret must be shown now; the old key is retired by hand.
        return { key, retireFailed: true };
      }
    },
    [identityKeysKey(brandId)],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (name.trim() && !isKeyName(name.trim())) next.name = t('setup.identity.create.nameInvalid');
    let publicJwk: Record<string, unknown> | undefined;
    if (kind === 'public') {
      const parsed = parseJwk(jwk);
      if ('jwk' in parsed) publicJwk = parsed.jwk;
      else next.jwk = t(`setup.identity.create.jwk.${parsed.problem}`);
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      const created = await create.mutateAsync({
        alg: kind === 'secret' ? 'HS256' : alg,
        ...(name.trim() ? { kid: name.trim() } : {}),
        ...(publicJwk ? { publicJwk } : {}),
      });
      onCreated(created);
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) {
          if (field.path === 'kid') fields.name = field.message;
          if (field.path.startsWith('publicJwk')) fields.jwk = field.message;
        }
        if (Object.keys(fields).length > 0) setErrors(fields);
      }
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({
        fieldId: field === 'name' ? 'idk-name' : 'idk-jwk',
        message,
      }))
    : [];

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
      title={
        replacing
          ? t('setup.identity.rotate.title', { kid: replacing.kid })
          : t('setup.identity.create.title')
      }
      description={
        replacing ? t('setup.identity.rotate.description') : t('setup.identity.create.description')
      }
      testId="create-identity-key-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate autoComplete="off">
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        {replacing ? null : (
          <ChoiceField
            id="idk-kind"
            legend={t('setup.identity.create.kind')}
            value={kind}
            onValueChange={(value) => setKind(value as Kind)}
            choices={[
              {
                value: 'secret',
                label: t('setup.identity.create.secret'),
                hint: t('setup.identity.create.secretHint'),
              },
              {
                value: 'public',
                label: t('setup.identity.create.public'),
                hint: t('setup.identity.create.publicHint'),
              },
            ]}
          />
        )}
        {kind === 'public' ? (
          <>
            <SelectField
              id="idk-alg"
              label={t('setup.identity.create.alg')}
              value={alg}
              disabled={replacing !== null}
              onChange={(event) => setAlg(event.target.value as PublicAlgorithm)}
              options={PUBLIC_ALGORITHMS.map((value) => ({
                value,
                label: t(`setup.identity.algs.${value}`),
              }))}
            />
            <TextareaField
              id="idk-jwk"
              label={t('setup.identity.create.jwk.label')}
              hint={t('setup.identity.create.jwk.hint')}
              value={jwk}
              rows={6}
              dir="ltr"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setJwk(event.target.value)}
              error={errors.jwk}
            />
          </>
        ) : null}
        <TextField
          id="idk-name"
          label={t('setup.identity.create.name')}
          hint={t('setup.identity.create.nameHint')}
          labelNote={t('app.optional')}
          value={name}
          dir="ltr"
          maxLength={64}
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
        />
        <ActionError error={isCancelled(create.error) ? null : create.error} />
        {isCancelled(create.error) ? (
          <p role="status" className="text-sm text-text-secondary">
            {t('app.cancelled')}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={create.isPending}>
            {kind === 'secret'
              ? t('setup.identity.create.submitSecret')
              : t('setup.identity.create.submitPublic')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function KeysTable({
  brandId,
  items,
  editable,
  onRotate,
}: {
  brandId: string;
  items: IdentityKey[];
  editable: boolean;
  onRotate: (key: IdentityKey) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [revoking, setRevoking] = useState<IdentityKey | null>(null);
  const revoke = useStudioMutation(
    (kid: string, tenant) =>
      api<IdentityKey>(
        `/v1/admin/brands/${brandId}/identity-keys/${encodeURIComponent(kid)}/revoke`,
        { method: 'POST', tenant },
      ),
    [identityKeysKey(brandId)],
  );
  return (
    <>
      <div className="rounded-xl border border-border bg-surface shadow-sm">
        <Table data-testid="identity-keys-table">
          <TableHeader>
            <TableRow>
              <TableHead className="text-start">{t('setup.identity.columns.name')}</TableHead>
              <TableHead className="text-start">{t('setup.identity.columns.type')}</TableHead>
              <TableHead className="text-start">{t('setup.identity.columns.status')}</TableHead>
              <TableHead className="text-start">{t('setup.identity.columns.added')}</TableHead>
              <TableHead className="text-start">{t('setup.identity.columns.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((key) => (
              <TableRow key={key.kid} data-key={key.kid}>
                <TableCell className="font-medium">
                  <bdi dir="ltr" className="font-mono">
                    {key.kid}
                  </bdi>
                </TableCell>
                <TableCell>{t(`setup.identity.algs.${key.alg}`)}</TableCell>
                <TableCell>
                  <StatusBadge tone={statusTone[key.status]}>
                    {t(`setup.identity.status.${key.status}`)}
                  </StatusBadge>
                </TableCell>
                <TableCell>{formatDateTime(key.createdAt)}</TableCell>
                <TableCell>
                  {editable && key.status !== 'revoked' ? (
                    <div className="flex flex-wrap gap-2">
                      {key.status === 'active' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onRotate(key)}
                          aria-label={t('setup.identity.rotate.label', { kid: key.kid })}
                        >
                          {t('setup.identity.rotate.action')}
                        </Button>
                      ) : null}
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setRevoking(key)}
                        aria-label={t('setup.identity.revoke.label', { kid: key.kid })}
                      >
                        {t('setup.identity.revoke.action')}
                      </Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {revoking ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
          title={t('setup.identity.revoke.title', { kid: revoking.kid })}
          confirmLabel={t('setup.identity.revoke.confirm')}
          variant="destructive-solid"
          testId="revoke-identity-key-dialog"
          onConfirm={async () => {
            await revoke.mutateAsync(revoking.kid);
            announce(t('setup.identity.revoke.done', { kid: revoking.kid }));
          }}
        >
          <p>{t('setup.identity.revoke.body')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/**
 * Customer identity (W12): the keys that let a brand's own website vouch for who a customer is, so
 * a signed-in customer keeps their chats on every device. For a developer: a business that does
 * not sign its customers in has nothing to set up here.
 */
export function IdentityPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const search = useSearch({ from: '/_studio/customer-identity' });
  const navigate = useNavigate({ from: '/customer-identity' });
  const { brands, active, chosen } = useChosenBrand(search.brand);
  const keys = useIdentityKeys(chosen?.id);
  const [creating, setCreating] = useState(false);
  const [replacing, setReplacing] = useState<IdentityKey | null>(null);
  const [secret, setSecret] = useState<{ value: string; kid: string } | null>(null);
  const [retireFailed, setRetireFailed] = useState<string | null>(null);
  const editable = can('widget.identity_keys');

  const open = (key: IdentityKey | null) => {
    setReplacing(key);
    setCreating(true);
  };

  const addButton = (
    <ReasonedAction reason={editable ? null : t('setup.identity.noPermission')}>
      <Button onClick={() => open(null)} data-testid="create-identity-key">
        <PlusIcon aria-hidden="true" />
        {t('setup.identity.create.action')}
      </Button>
    </ReasonedAction>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('setup.identity.title')}
        description={t('setup.identity.description')}
        actions={chosen ? addButton : null}
      />
      <p className="text-sm text-text-secondary">
        <a
          href={DOCS.identity}
          target="_blank"
          rel="noopener noreferrer"
          className="text-link underline underline-offset-4 hover:no-underline"
        >
          {t('setup.identity.guide')}
        </a>
      </p>
      <QueryState
        query={{
          data: brands.items,
          error: brands.error,
          isPending: brands.pending,
          isRefetching: brands.isRefetching,
          refetch: brands.refetch,
        }}
        label={t('setup.identity.loading')}
        permitted={brands.permitted && editable}
        isEmpty={() => active.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('setup.hours.noBrands.title')}
            description={t('setup.identity.noBrands')}
            action={
              <Button asChild>
                <Link to="/brands">{t('setup.hours.noBrands.action')}</Link>
              </Button>
            }
          />
        }
      >
        {() =>
          chosen ? (
            <div className="flex flex-col gap-6">
              <BrandPicker
                id="identity-brand"
                label={t('setup.brand')}
                brands={active}
                value={chosen.id}
                onChange={(brandId) => navigate({ search: { brand: brandId } })}
              />
              {retireFailed ? (
                <p
                  role="alert"
                  className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-text"
                >
                  {t('setup.identity.rotate.retireFailed', { kid: retireFailed })}
                </p>
              ) : null}
              <QueryState
                query={keys}
                label={t('setup.identity.loading')}
                isEmpty={(data) => data.items.length === 0}
                empty={
                  <EmptyState
                    kind="no-records"
                    title={t('setup.identity.empty.title')}
                    description={t('setup.identity.empty.description')}
                    icon={<KeyRoundIcon className="size-6 text-text-muted" aria-hidden="true" />}
                    action={addButton}
                  />
                }
              >
                {(data) => (
                  <KeysTable
                    brandId={chosen.id}
                    items={data.items}
                    editable={editable}
                    onRotate={(key) => open(key)}
                  />
                )}
              </QueryState>
              <Section
                id="identity-rotation"
                title={t('setup.identity.how.title')}
                description={t('setup.identity.how.description')}
              >
                <ol className="list-decimal ps-5 text-sm text-text">
                  <li>{t('setup.identity.how.step1')}</li>
                  <li>{t('setup.identity.how.step2')}</li>
                  <li>{t('setup.identity.how.step3')}</li>
                </ol>
              </Section>
              <CreateKeyDialog
                brandId={chosen.id}
                open={creating}
                replacing={replacing}
                onOpenChange={setCreating}
                onCreated={({ key, retireFailed: failed }) => {
                  setRetireFailed(failed && replacing ? replacing.kid : null);
                  announce(t('setup.identity.created', { kid: key.kid }));
                  if (key.secret) setSecret({ value: key.secret, kid: key.kid });
                }}
              />
              <SecretReveal
                secret={secret?.value ?? null}
                title={t('setup.identity.reveal.title')}
                label={t('setup.identity.reveal.label', { kid: secret?.kid ?? '' })}
                onDone={() => setSecret(null)}
                testId="identity-secret"
              />
            </div>
          ) : null
        }
      </QueryState>
    </div>
  );
}
