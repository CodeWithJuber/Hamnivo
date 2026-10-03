import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { FlaskConicalIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type SimulationRun,
  type SimulationSuite,
  toolKeys,
  useSimulationRuns,
  useSimulations,
} from '../lib/actions';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useStudioMutation } from '../lib/queries';
import { isCancelled } from '../lib/reauth';
import { useTenant } from '../lib/tenant';
import { AppDialog, ConfirmDialog, DialogFooter } from './AppDialog';
import { CheckboxField, TextareaField, TextField } from './Fields';
import { ActionError, QueryState } from './States';

type CaseResult = SimulationRun['results'][number]['candidate'];

const EXAMPLE = JSON.stringify(
  [
    {
      id: 'address-change',
      name: 'An address change asks the customer first',
      messages: ['Please change the delivery address of order NL-1048 to 2 Palm Road'],
      tools: { demo_update_address: { output: { ok: true } } },
      expect: {
        outcome: 'replied',
        actions: [{ tool: 'demo_update_address', decision: 'approval' }],
      },
    },
    {
      id: 'person',
      name: 'Asking for a person hands over',
      messages: ['I want to talk to a person'],
      expect: { outcome: 'handoff' },
    },
  ],
  null,
  2,
);

function Outcome({ result }: { result: CaseResult | null }) {
  const { t } = useTranslation();
  if (!result) return <p className="text-sm text-text-secondary">{t('tools.sims.noPublished')}</p>;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="font-medium text-text">{t(`tools.sims.outcomes.${result.outcome}`)}</p>
      {result.actions.length === 0 ? (
        <p className="text-text-secondary">{t('tools.sims.noActions')}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {result.actions.map((action, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: actions are an ordered record of one run
            <li key={index}>
              <bdi dir="ltr" className="font-mono text-xs">
                {action.tool}
              </bdi>{' '}
              · {t(`tools.sims.decisions.${action.decision}`)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One run: what the draft does, case by case, next to the published version (HNV-11-04). */
function RunResults({ run }: { run: SimulationRun }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t('tools.sims.results')}
      className="flex flex-col gap-3"
      data-testid="simulation-results"
      data-status={run.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={run.status === 'passed' ? 'success' : 'danger'}>
          {t(`tools.sims.status.${run.status}`)}
        </StatusBadge>
        <span className="text-sm text-text-secondary">
          {t('tools.sims.summary', {
            cases: run.summary.cases,
            changed: run.summary.changed,
            failed: run.summary.failed,
          })}
        </span>
        <StatusBadge
          tone="neutral"
          icon={<FlaskConicalIcon className="size-3.5" aria-hidden="true" />}
        >
          {t('tools.sims.testOnly')}
        </StatusBadge>
      </div>
      <ol className="flex flex-col gap-3">
        {run.results.map((result) => (
          <li
            key={result.caseId}
            className="flex flex-col gap-3 rounded-lg border border-border p-3"
            data-case={result.caseId}
          >
            <p className="font-medium text-text">
              <bdi>{result.name}</bdi>
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <h4 className="text-xs font-semibold text-text-secondary">
                  {t('tools.sims.draft')}
                </h4>
                <Outcome result={result.candidate} />
              </div>
              <div className="flex flex-col gap-1">
                <h4 className="text-xs font-semibold text-text-secondary">
                  {t('tools.sims.published')}
                </h4>
                <Outcome result={result.baseline} />
              </div>
            </div>
            {result.failures.length > 0 ? (
              <div className="rounded-md bg-danger-subtle p-2 text-sm" data-testid="case-failures">
                <p className="font-medium text-danger">{t('tools.sims.failures')}</p>
                <ul className="list-disc ps-5 text-text">
                  {result.failures.map((failure) => (
                    <li key={failure}>
                      <bdi>{failure}</bdi>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="text-sm" data-testid="case-changes">
              <p className="font-medium text-text">{t('tools.sims.changes')}</p>
              {result.changes.length === 0 ? (
                <p className="text-text-secondary">{t('tools.sims.noChanges')}</p>
              ) : (
                <ul className="list-disc ps-5 text-text">
                  {result.changes.map((change) => (
                    <li key={change}>
                      <bdi>{change}</bdi>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {result.candidate.replies.length > 0 ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-text-secondary">
                  {t('tools.sims.replies')}
                </summary>
                <ul className="mt-1 flex flex-col gap-1">
                  {result.candidate.replies.map((reply, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: replies are in conversation order
                    <li key={index} className="rounded-md bg-surface-sunken p-2 text-text">
                      <bdi>{reply}</bdi>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function SuiteDialog({
  open,
  onOpenChange,
  agentId,
  suite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  suite: SimulationSuite | null;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [required, setRequired] = useState(false);
  const [cases, setCases] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(suite?.name ?? '');
    setRequired(suite?.required ?? false);
    setCases(suite ? JSON.stringify(suite.cases, null, 2) : EXAMPLE);
    setErrors({});
  }, [open, suite]);

  const save = useStudioMutation(
    (body: { name: string; required: boolean; cases: unknown }, tenant) =>
      api<SimulationSuite>(
        `/v1/admin/agents/${agentId}/simulations${suite ? `/${suite.id}` : ''}`,
        { method: suite ? 'PUT' : 'POST', body, tenant },
      ),
    [toolKeys.simulations(agentId)],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next['suite-name'] = t('tools.sims.errors.name');
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(cases);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('not a list');
    } catch {
      next['suite-cases'] = t('tools.sims.errors.cases');
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await save.mutateAsync({ name: name.trim(), required, cases: parsed });
      onOpenChange(false);
    } catch {
      // Shown below.
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
      }}
      title={suite ? t('tools.sims.editTitle') : t('tools.sims.addTitle')}
      description={t('tools.sims.dialogDescription')}
      className="sm:max-w-2xl"
      testId="suite-dialog"
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          id="suite-name"
          label={t('tools.sims.name')}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          error={errors['suite-name']}
        />
        <CheckboxField
          id="suite-required"
          label={t('tools.sims.requiredLabel')}
          hint={t('tools.sims.requiredHint')}
          checked={required}
          onCheckedChange={setRequired}
        />
        <TextareaField
          id="suite-cases"
          label={t('tools.sims.cases')}
          hint={t('tools.sims.casesHint')}
          value={cases}
          rows={14}
          dir="ltr"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => setCases(event.target.value)}
          error={errors['suite-cases']}
        />
        <ActionError error={isCancelled(save.error) ? null : save.error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={save.isPending}>
            {t('tools.sims.save')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function SuiteItem({
  agentId,
  suite,
  draftVersion,
  manage,
  onEdit,
  onDelete,
}: {
  agentId: string;
  suite: SimulationSuite;
  draftVersion: number | undefined;
  manage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const runs = useSimulationRuns(agentId, suite.id);
  const latest = runs.data?.items[0];
  const onDraft = latest && draftVersion !== undefined && latest.candidateVersion === draftVersion;
  const run = useStudioMutation(
    (_: undefined, tenant) =>
      api<SimulationRun>(`/v1/admin/agents/${agentId}/simulations/${suite.id}/runs`, {
        method: 'POST',
        tenant,
      }),
    [toolKeys.simulationRuns(agentId, suite.id)],
  );
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-4" data-suite={suite.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-text">
            <bdi>{suite.name}</bdi>
          </p>
          <p className="text-xs text-text-secondary">
            {t('tools.sims.caseCount', { total: suite.cases.length })}
            {' · '}
            {onDraft && latest
              ? t('tools.sims.lastRun', {
                  time: formatDateTime(latest.finishedAt),
                  status: t(`tools.sims.status.${latest.status}`),
                })
              : t('tools.sims.notRun')}
          </p>
        </div>
        <StatusBadge tone={suite.required ? 'brand' : 'neutral'} icon={null}>
          {suite.required ? t('tools.sims.required') : t('tools.sims.optional')}
        </StatusBadge>
      </div>
      {manage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            busy={run.isPending}
            disabled={draftVersion === undefined}
            onClick={async () => {
              try {
                const result = await run.mutateAsync();
                announce(t(`tools.sims.status.${result.status}`));
              } catch {
                // Shown below.
              }
            }}
            aria-label={t('tools.sims.runLabel', { name: suite.name })}
            data-testid="run-suite"
          >
            <PlayIcon className="rtl:-scale-x-100" aria-hidden="true" />
            {t('tools.sims.run')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <PencilIcon aria-hidden="true" />
            {t('tools.sims.edit')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2Icon aria-hidden="true" />
            {t('tools.sims.delete')}
          </Button>
        </div>
      ) : null}
      {draftVersion === undefined ? (
        <p className="text-sm text-text-secondary">{t('tools.sims.noDraft')}</p>
      ) : null}
      <ActionError error={isCancelled(run.error) ? null : run.error} />
      {onDraft && latest ? <RunResults run={latest} /> : null}
    </li>
  );
}

/**
 * The agent's test room (G11, HNV-11-04/05): suites of sample conversations replayed with a test
 * model and fake tools, against this draft and the published version. Nothing is sent and no
 * customer data is used; a suite marked required must pass before the draft can be published.
 */
export function Simulations({
  agentId,
  draftVersion,
}: {
  agentId: string;
  draftVersion: number | undefined;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const suites = useSimulations(agentId);
  const manage = can('agents.manage');
  const [editing, setEditing] = useState<SimulationSuite | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<SimulationSuite | null>(null);
  const remove = useStudioMutation(
    (suiteId: string, tenant) =>
      api(`/v1/admin/agents/${agentId}/simulations/${suiteId}`, { method: 'DELETE', tenant }),
    [toolKeys.simulations(agentId)],
  );
  return (
    <section
      aria-labelledby="simulations-title"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
      data-testid="simulations"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="simulations-title" className="text-lg font-semibold text-text">
            {t('tools.sims.title')}
          </h2>
          <p className="max-w-prose text-sm text-text-secondary">{t('tools.sims.description')}</p>
        </div>
        {manage ? (
          <Button
            variant="secondary"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <PlusIcon aria-hidden="true" />
            {t('tools.sims.add')}
          </Button>
        ) : null}
      </div>
      <QueryState
        query={suites}
        label={t('tools.sims.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('tools.sims.empty')}</p>}
      >
        {(data) => (
          <ul className="flex flex-col gap-3">
            {data.items.map((suite) => (
              <SuiteItem
                key={suite.id}
                agentId={agentId}
                suite={suite}
                draftVersion={draftVersion}
                manage={manage}
                onEdit={() => {
                  setEditing(suite);
                  setDialogOpen(true);
                }}
                onDelete={() => setDeleting(suite)}
              />
            ))}
          </ul>
        )}
      </QueryState>
      <SuiteDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        agentId={agentId}
        suite={editing}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('tools.sims.deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('tools.sims.delete')}
        variant="destructive-solid"
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
        }}
      >
        <p>{t('tools.sims.deleteBody')}</p>
      </ConfirmDialog>
    </section>
  );
}
