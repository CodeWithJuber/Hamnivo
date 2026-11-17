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
import { GoLiveNotices } from '../components/agent/GoLiveNotices';
import { AgentBadge } from '../components/Badges';
import { CheckboxField, SelectField, TextField } from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import {
  type AnswerState,
  type DirectoryFilters,
  type DirectoryRow,
  directoryRow,
  isFiltered,
  type ModelRef,
  NO_FILTERS,
  rowMatches,
  type StateFilter,
} from '../lib/agent-directory';
import { api, newIdempotencyKey } from '../lib/api';
import { useBrandRefs, useNames } from '../lib/names';
import { keys, useAgentDetails, useAgents, useStudioMutation } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { Agent, AgentDetail, CreateAgentRequest } from '../lib/types';

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

/** A model as people read it: the provider's name, then the model's own ID. */
function ModelName({ model }: { model: ModelRef }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-col">
      <span>{t(`editor.providers.${model.provider}`)}</span>
      <bdi dir="ltr" className="font-mono text-xs text-text-secondary">
        {model.modelId}
      </bdi>
    </span>
  );
}

const NARROW = '(max-width: 47.99rem)';

/** Whether the screen is phone-sized; it follows rotation and resizing. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(NARROW).matches),
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

/** The agent's names, what it is for and whether it is the brand's default. */
function AgentIdentity({ row }: { row: DirectoryRow }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <Link
        to="/agents/$agentId"
        params={{ agentId: row.agent.id }}
        className="font-medium text-link underline underline-offset-4 hover:no-underline"
        aria-label={t('agents.open', { name: row.agent.name })}
      >
        <bdi>{row.agent.name}</bdi>
      </Link>
      {row.displayName ? (
        <span className="text-xs text-text-secondary">
          <bdi>{row.displayName}</bdi>
        </span>
      ) : null}
      <span className="line-clamp-2 text-sm text-text" data-testid="agent-purpose">
        {row.loading ? (
          <Skeleton className="h-3 w-48" />
        ) : row.purpose ? (
          <bdi>{row.purpose}</bdi>
        ) : (
          <span className="text-text-muted">{t('agents.noPurpose')}</span>
        )}
      </span>
      {row.agent.isDefault ? (
        <StatusBadge tone="brand" icon={null} className="w-fit">
          {t('agents.isDefault')}
        </StatusBadge>
      ) : null}
    </div>
  );
}

/** Which brand, and where the agent answers. */
function AgentAnswers({ row }: { row: DirectoryRow }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-text">
        <bdi>{row.brandName}</bdi>
      </span>
      {row.loading ? (
        <Skeleton className="h-6 w-40 rounded-full" />
      ) : (
        <StatusBadge
          tone={ANSWER_TONE[row.answer]}
          icon={null}
          className="h-auto w-fit py-1 whitespace-normal"
          data-answer={row.answer}
        >
          {t(`agents.answers.${row.answer}`, { brand: row.brandName })}
        </StatusBadge>
      )}
    </div>
  );
}

/** The model customers get, and the draft’s when it differs. */
function AgentModel({ row }: { row: DirectoryRow }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      {row.liveModel ? (
        <ModelName model={row.liveModel} />
      ) : row.loading ? (
        <Skeleton className="h-4 w-28" />
      ) : (
        <span className="text-text-muted">—</span>
      )}
      {row.draftModel ? (
        <span className="text-xs text-text-secondary" data-testid="draft-model">
          {t('agents.draftModel', {
            model: `${t(`editor.providers.${row.draftModel.provider}`)} · ${row.draftModel.modelId}`,
          })}
        </span>
      ) : null}
    </div>
  );
}

const ANSWER_TONE: Record<AnswerState, 'success' | 'info' | 'neutral' | 'warning'> = {
  customers: 'success',
  assist: 'info',
  notDefault: 'warning',
  notLive: 'neutral',
  archived: 'neutral',
};

/**
 * The directory (HNV-11-01): each agent's purpose, where it answers, the model and version
 * customers get, found by typing or filtering by brand and by whether it answers now. Provider
 * connections and keys are never shown here.
 */
function AgentDirectory({ agents }: { agents: Agent[] }) {
  const { t } = useTranslation();
  const names = useNames();
  const details = useAgentDetails(agents.map((agent) => agent.id));
  const [filters, setFilters] = useState<DirectoryFilters>(NO_FILTERS);
  const narrow = useNarrow();
  const detailOf = new Map(
    details.flatMap((q) => (q.data ? [[q.data.agent.id, q.data] as const] : [])),
  );
  const rows = agents.map((agent) =>
    directoryRow(agent, detailOf.get(agent.id), names.brand(agent.brandId) ?? agent.brandId),
  );
  const shown = rows.filter((row) => rowMatches(row, filters));
  const brands = [...new Map(rows.map((row) => [row.agent.brandId, row.brandName])).entries()];
  const filtered = isFiltered(filters);
  const set = (patch: Partial<DirectoryFilters>) => setFilters((now) => ({ ...now, ...patch }));

  return (
    <div className="flex flex-col gap-4">
      {/* The page's only search landmark: it needs no name of its own beside the field's. */}
      <search className="flex flex-wrap items-start gap-3" data-testid="agents-filters">
        <div className="min-w-56 flex-[2]">
          <TextField
            id="agents-search"
            type="search"
            label={t('agents.filters.search')}
            hint={t('agents.filters.searchHint')}
            value={filters.query}
            onChange={(event) => set({ query: event.target.value })}
          />
        </div>
        {brands.length > 1 ? (
          <div className="min-w-44 flex-1">
            <SelectField
              id="agents-brand"
              label={t('agents.filters.brand')}
              value={filters.brandId}
              onChange={(event) => set({ brandId: event.target.value })}
              options={[
                { value: '', label: t('agents.filters.allBrands') },
                ...brands.map(([value, label]) => ({ value, label })),
              ]}
            />
          </div>
        ) : null}
        <div className="min-w-44 flex-1">
          <SelectField
            id="agents-state"
            label={t('agents.filters.state')}
            value={filters.state}
            onChange={(event) => set({ state: event.target.value as StateFilter })}
            options={[
              { value: 'all', label: t('agents.filters.all') },
              { value: 'answering', label: t('agents.filters.answering') },
              { value: 'idle', label: t('agents.filters.idle') },
            ]}
          />
        </div>
      </search>
      <p role="status" className="text-sm text-text-secondary" data-testid="agents-count">
        {filtered ? t('agents.filters.count', { shown: shown.length, total: rows.length }) : ''}
      </p>
      {shown.length === 0 ? (
        <EmptyState
          kind="no-matches"
          title={t('agents.filters.none')}
          action={
            <Button variant="secondary" onClick={() => setFilters(NO_FILTERS)}>
              {t('agents.filters.clear')}
            </Button>
          }
        />
      ) : narrow ? (
        // On a phone each agent is a card: four columns do not fit, and squeezed they are unreadable.
        <ul className="flex flex-col gap-3" data-testid="agents-cards">
          {shown.map((row) => (
            <li
              key={row.agent.id}
              data-agent={row.agent.name}
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm"
            >
              <AgentIdentity row={row} />
              <AgentAnswers row={row} />
              <div className="flex flex-wrap items-start justify-between gap-3">
                <AgentModel row={row} />
                <AgentBadge agent={row.agent} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-border bg-surface shadow-sm">
          <Table data-testid="agents-table">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('agents.columns.name')}</TableHead>
                <TableHead className="text-start">{t('agents.columns.answers')}</TableHead>
                <TableHead className="text-start">{t('agents.columns.model')}</TableHead>
                <TableHead className="text-start">{t('agents.columns.live')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
                <TableRow key={row.agent.id} data-agent={row.agent.name}>
                  <TableCell className="max-w-96 py-3 align-top whitespace-normal">
                    <AgentIdentity row={row} />
                  </TableCell>
                  <TableCell className="max-w-72 py-3 align-top whitespace-normal">
                    <AgentAnswers row={row} />
                  </TableCell>
                  <TableCell className="py-3 align-top">
                    <AgentModel row={row} />
                  </TableCell>
                  <TableCell className="py-3 align-top">
                    <AgentBadge agent={row.agent} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/** AI agents (board 11, HNV-11-01): purpose, brand, model and which version customers get. */
export function AgentsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const agents = useAgents();
  const [creating, setCreating] = useState(false);

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
      <GoLiveNotices />
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
        {(data) => <AgentDirectory agents={data.items} />}
      </QueryState>
      {can('agents.manage') ? (
        <CreateAgentDialog open={creating} onOpenChange={setCreating} />
      ) : null}
    </div>
  );
}
