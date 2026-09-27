import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { Skeleton } from '@hamnivo/ui/components/skeleton';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Link, useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../components/AppDialog';
import { AgentBadge } from '../components/Badges';
import { CheckboxField, SelectField, TextField } from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { api, newIdempotencyKey } from '../lib/api';
import { useBrandRefs, useNames } from '../lib/names';
import { keys, useAgentDetails, useAgents, useStudioMutation } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { AgentDetail, CreateAgentRequest } from '../lib/types';

function CreateAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const navigate = useNavigate();
  const brands = useBrandRefs();
  const [brandId, setBrandId] = useState('');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setBrandId('');
    setName('');
    setDisplayName('');
    setIsDefault(false);
    setErrors({});
    setAttempted(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const create = useStudioMutation(
    (body: CreateAgentRequest, tenant) =>
      api<AgentDetail>('/v1/admin/agents', { method: 'POST', body, tenant, idempotencyKey }),
    [keys.agents],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!brandId) next.brand = t('agents.createForm.brandRequired');
    if (!name.trim()) next.name = t('agents.createForm.nameRequired');
    if (!displayName.trim() || displayName.trim().length > 60) {
      next.displayName = t('editor.errors.displayName');
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      // New agents start on the offline test model; the editor changes it before publishing.
      const detail = await create.mutateAsync({
        brandId,
        name: name.trim(),
        isDefault,
        config: {
          displayName: displayName.trim(),
          model: { provider: 'mock', modelId: 'hamnivo-mock' },
        },
      });
      announce(t('agents.createForm.created', { name: detail.agent.name }));
      onOpenChange(false);
      await navigate({ to: '/agents/$agentId', params: { agentId: detail.agent.id } });
    } catch {
      // Shown below the form.
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `agent-${field}`, message }))
    : [];
  const options = (brands.items ?? []).map((b) => ({ value: b.id, label: b.name }));

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
      title={t('agents.createForm.title')}
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        {options.length === 0 && !brands.pending ? (
          <p className="text-sm text-warning">{t('agents.createForm.noBrands')}</p>
        ) : null}
        <SelectField
          id="agent-brand"
          label={t('agents.createForm.brand')}
          value={brandId}
          onChange={(event) => setBrandId(event.target.value)}
          placeholder={t('stopAi.choose')}
          options={options}
          error={errors.brand}
        />
        <TextField
          id="agent-name"
          label={t('agents.createForm.name')}
          hint={t('agents.createForm.nameHint')}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
        />
        <TextField
          id="agent-displayName"
          label={t('editor.displayName')}
          hint={t('editor.displayNameHint')}
          value={displayName}
          maxLength={60}
          onChange={(event) => setDisplayName(event.target.value)}
          error={errors.displayName}
        />
        <CheckboxField
          id="agent-default"
          label={t('agents.createForm.makeDefault')}
          hint={t('agents.createForm.makeDefaultHint')}
          checked={isDefault}
          onCheckedChange={setIsDefault}
        />
        <ActionError error={create.error} />
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
            {t('agents.createForm.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** AI agents (board 11, HNV-11-01): purpose, brand, model and which version customers get. */
export function AgentsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const agents = useAgents();
  const names = useNames();
  const details = useAgentDetails(agents.data?.items.map((a) => a.id) ?? []);
  const [creating, setCreating] = useState(false);
  const detailOf = new Map(
    details.flatMap((q) => (q.data ? [[q.data.agent.id, q.data] as const] : [])),
  );

  const create = can('agents.manage') ? (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon aria-hidden="true" />
      {t('agents.create')}
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('agents.title')}
        description={t('agents.description')}
        actions={create}
      />
      <QueryState
        query={agents}
        label={t('agents.loading')}
        permitted={can('agents.read')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('agents.empty.title')}
            description={t('agents.empty.description')}
            action={
              can('agents.manage') ? (
                <Button onClick={() => setCreating(true)}>{t('agents.create')}</Button>
              ) : (
                <Button asChild variant="secondary">
                  <Link to="/brands">{t('nav.brands')}</Link>
                </Button>
              )
            }
          />
        }
      >
        {(data) => (
          <div className="rounded-xl border border-border bg-surface shadow-sm">
            <Table data-testid="agents-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{t('agents.columns.name')}</TableHead>
                  <TableHead className="text-start">{t('agents.columns.brand')}</TableHead>
                  <TableHead className="text-start">{t('agents.columns.model')}</TableHead>
                  <TableHead className="text-start">{t('agents.columns.live')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((agent) => {
                  const detail = detailOf.get(agent.id);
                  const config = (detail?.draft ?? detail?.published)?.config;
                  return (
                    <TableRow key={agent.id} data-agent={agent.name}>
                      <TableCell className="py-3">
                        <div className="flex flex-col gap-1">
                          <Link
                            to="/agents/$agentId"
                            params={{ agentId: agent.id }}
                            className="font-medium text-link underline underline-offset-4 hover:no-underline"
                            aria-label={t('agents.open', { name: agent.name })}
                          >
                            <bdi>{agent.name}</bdi>
                          </Link>
                          {config ? (
                            <span className="text-xs text-text-secondary">
                              <bdi>{config.displayName}</bdi>
                            </span>
                          ) : null}
                          {agent.isDefault ? (
                            <StatusBadge tone="brand" icon={null} className="w-fit">
                              {t('agents.isDefault')}
                            </StatusBadge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <bdi>{names.brand(agent.brandId) ?? agent.brandId}</bdi>
                      </TableCell>
                      <TableCell>
                        {config ? (
                          <span className="flex flex-col">
                            <span>{t(`editor.providers.${config.model.provider}`)}</span>
                            <bdi dir="ltr" className="font-mono text-xs text-text-secondary">
                              {config.model.modelId}
                            </bdi>
                          </span>
                        ) : (
                          <Skeleton className="h-4 w-28" />
                        )}
                      </TableCell>
                      <TableCell>
                        <AgentBadge agent={agent} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
      {can('agents.manage') ? (
        <CreateAgentDialog open={creating} onOpenChange={setCreating} />
      ) : null}
    </div>
  );
}
