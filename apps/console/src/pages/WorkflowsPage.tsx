import { WorkflowDefinition as DefinitionSchema } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandPicker, useChosenBrand } from '../components/BrandPicker';
import {
  CheckboxField,
  type Option,
  SelectField,
  TextareaField,
  TextField,
} from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { useTools } from '../lib/actions';
import { api, newIdempotencyKey } from '../lib/api';
import { useAgents, useStudioMutation, useStudioQuery } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import {
  newWorkflowStep,
  removeWorkflowStep,
  useWorkflowChange,
  useWorkflows,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowTemplate,
  workflowTemplate,
} from '../lib/workflows';
import { DiscardChangesDialog, LeaveGuard } from './settings/DiscardChangesDialog';

const TYPES: WorkflowStep['type'][] = [
  'trigger',
  'condition',
  'knowledge_lookup',
  'tool_action',
  'approval',
  'wait',
  'delegate',
  'handoff',
];
function StepEditor({
  step,
  steps,
  change,
  remove,
  toolChoices,
  delegateChoices,
}: {
  step: WorkflowStep;
  steps: WorkflowStep[];
  change: (s: WorkflowStep) => void;
  remove: () => void;
  toolChoices: Option[];
  delegateChoices: Option[];
}) {
  const { t } = useTranslation();
  const [argumentText, setArgumentText] = useState(
    'arguments' in step ? JSON.stringify(step.arguments, null, 2) : '{}',
  );
  const [invalid, setInvalid] = useState(false);
  const choicesWithSaved = (choices: Option[], saved: string, unavailable: string): Option[] =>
    saved && !choices.some((choice) => choice.value === saved)
      ? [{ value: saved, label: unavailable, disabled: true }, ...choices]
      : choices;
  const delegateValue =
    step.type === 'delegate'
      ? step.agentId
        ? `agent:${step.agentId}`
        : step.connectionId
          ? `connection:${step.connectionId}`
          : ''
      : '';
  const patch = (v: Record<string, unknown>) => change({ ...step, ...v } as WorkflowStep);
  const target = (label: string, value: string | null, set: (v: string | null) => void) => (
    <SelectField
      id={`${step.id}-${label.replaceAll(' ', '-')}`}
      label={label}
      value={value ?? ''}
      onChange={(e) => set(e.target.value || null)}
    >
      <option value="">—</option>
      {steps
        .filter((s) => s.id !== step.id)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.label} ({s.id})
          </option>
        ))}
    </SelectField>
  );
  return (
    <li className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">
          <bdi>{step.id}</bdi>
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={remove}
          disabled={steps.length === 1}
        >
          {t('agentic.remove')}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={`${step.id}-label`}
          label={t('agentic.name')}
          value={step.label}
          required
          maxLength={100}
          onChange={(e) => patch({ label: e.target.value })}
        />
        <SelectField
          id={`${step.id}-type`}
          label={t('agentic.type')}
          value={step.type}
          onChange={(e) =>
            change(newWorkflowStep(e.target.value as WorkflowStep['type'], step.id, step.label))
          }
        >
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`agentic.stepTypes.${type}`)}
            </option>
          ))}
        </SelectField>
      </div>
      {'query' in step ? (
        <TextareaField
          id={`${step.id}-query`}
          label={t('agentic.query')}
          value={step.query}
          required
          maxLength={1000}
          onChange={(e) => patch({ query: e.target.value })}
        />
      ) : null}
      {'seconds' in step ? (
        <TextField
          id={`${step.id}-seconds`}
          label={t('agentic.seconds')}
          type="number"
          min={1}
          max={86400}
          value={step.seconds}
          onChange={(e) => patch({ seconds: Number(e.target.value) })}
        />
      ) : null}
      {'reason' in step ? (
        <TextField
          id={`${step.id}-reason`}
          label={t('agentic.reason')}
          value={step.reason}
          required
          maxLength={500}
          onChange={(e) => patch({ reason: e.target.value })}
        />
      ) : null}
      {'toolId' in step ? (
        <>
          <SelectField
            id={`${step.id}-tool`}
            label={t('agentic.actionTool')}
            hint={t('agentic.resourcePickerHint')}
            value={step.toolId}
            required
            placeholder="—"
            options={choicesWithSaved(toolChoices, step.toolId, t('agentic.unavailableTool'))}
            onChange={(event) => patch({ toolId: event.target.value })}
          />
          <TextareaField
            id={`${step.id}-arguments`}
            label={t('agentic.arguments')}
            value={argumentText}
            error={invalid ? t('agentic.invalidJson') : undefined}
            dir="ltr"
            onChange={(e) => {
              setArgumentText(e.target.value);
              try {
                const args: unknown = JSON.parse(e.target.value);
                if (!args || Array.isArray(args) || typeof args !== 'object') throw Error();
                setInvalid(false);
                patch({ arguments: args });
              } catch {
                setInvalid(true);
                patch({ arguments: null });
              }
            }}
          />
        </>
      ) : null}
      {'request' in step ? (
        <>
          <SelectField
            id={`${step.id}-delegate`}
            label={t('agentic.specialist')}
            hint={t('agentic.resourcePickerHint')}
            value={delegateValue}
            required
            placeholder="—"
            options={choicesWithSaved(
              delegateChoices,
              delegateValue,
              t('agentic.unavailableSpecialist'),
            )}
            onChange={(event) => {
              const selected = event.target.value;
              patch({
                agentId: selected.startsWith('agent:') ? selected.slice(6) : undefined,
                connectionId: selected.startsWith('connection:') ? selected.slice(11) : undefined,
              });
            }}
          />
          <TextareaField
            id={`${step.id}-request`}
            label={t('agentic.request')}
            value={step.request}
            required
            maxLength={4000}
            onChange={(e) => patch({ request: e.target.value })}
          />
        </>
      ) : null}
      {'predicate' in step ? (
        <>
          {step.predicate.field === 'result' || step.predicate.source ? (
            <p
              className="rounded-md border border-border bg-surface-sunken p-3 text-sm"
              data-testid="advanced-result-predicate"
            >
              {t('agentic.resultPredicateHint')}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField
                id={`${step.id}-field`}
                label={t('agentic.field')}
                value={step.predicate.field}
                onChange={(e) =>
                  patch({
                    predicate: {
                      ...step.predicate,
                      field: e.target.value,
                      value:
                        e.target.value === 'hours_open' || e.target.value === 'signed_in'
                          ? true
                          : '',
                    },
                  })
                }
              >
                {(['event', 'hours_open', 'signed_in', 'country', 'language', 'tag'] as const).map(
                  (f) => (
                    <option key={f} value={f}>
                      {t(`agentic.fields.${f}`)}
                    </option>
                  ),
                )}
              </SelectField>
              <SelectField
                id={`${step.id}-op`}
                label={t('agentic.operator')}
                value={step.predicate.op}
                onChange={(e) => patch({ predicate: { ...step.predicate, op: e.target.value } })}
              >
                {(['is', 'is_not', 'contains'] as const).map((op) => (
                  <option key={op} value={op}>
                    {t(`agentic.operators.${op}`)}
                  </option>
                ))}
              </SelectField>
              {typeof step.predicate.value === 'boolean' ? (
                <SelectField
                  id={`${step.id}-value`}
                  label={t('agentic.value')}
                  value={String(step.predicate.value)}
                  onChange={(e) =>
                    patch({ predicate: { ...step.predicate, value: e.target.value === 'true' } })
                  }
                >
                  <option value="true">{t('agentic.yes')}</option>
                  <option value="false">{t('agentic.no')}</option>
                </SelectField>
              ) : (
                <TextField
                  id={`${step.id}-value`}
                  label={t('agentic.value')}
                  value={step.predicate.value}
                  onChange={(e) =>
                    patch({ predicate: { ...step.predicate, value: e.target.value } })
                  }
                />
              )}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {target(t('agentic.whenMatched'), step.then, (v) => {
              // biome-ignore lint/suspicious/noThenProperty: required workflow branch contract field
              patch({ then: v });
            })}
            {target(t('agentic.otherwise'), step.otherwise, (v) => patch({ otherwise: v }))}
          </div>
        </>
      ) : null}
      {'next' in step ? target(t('agentic.next'), step.next, (v) => patch({ next: v })) : null}
    </li>
  );
}
function WorkflowEditor({
  workflow,
  brandId,
  onClose,
}: {
  workflow: Workflow | null;
  brandId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const change = useWorkflowChange(brandId);
  const agents = useAgents();
  const tools = useTools(brandId);
  const specialists = useStudioQuery<{ items: { id: string; name: string; enabled: boolean }[] }>(
    ['a2a', brandId],
    `/v1/admin/brands/${brandId}/a2a-connections`,
    { enabled: can('automations.read') && !!brandId },
  );
  const [name, setName] = useState(workflow?.name ?? '');
  const [definition, setDefinition] = useState<WorkflowDefinition>(
    () =>
      workflow?.draft ?? {
        agentId: '',
        allowedDelegateAgentIds: [],
        entry: 'start',
        trigger: { type: 'manual' },
        budget: { maxSteps: 20, maxDelegations: 0, maxDepth: 0, maxDurationSeconds: 3600 },
        steps: [
          {
            id: 'start',
            label: t('agentic.handoff'),
            type: 'handoff',
            reason: t('agentic.handoff'),
          },
        ],
      },
  );
  const [advancedText, setAdvancedText] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState('');
  const [eventKey, setEventKey] = useState(newIdempotencyKey);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty =
    advancedText !== null ||
    (workflow
      ? name !== workflow.name || JSON.stringify(definition) !== JSON.stringify(workflow.draft)
      : !!name);
  const versions = useStudioQuery<{ items: { version: number; name: string }[] }>(
    ['workflow-versions', workflow?.id],
    `/v1/admin/workflows/${workflow?.id}/versions`,
    { enabled: !!workflow },
  );
  const runs = useStudioQuery<{ items: WorkflowRun[] }>(
    ['workflow-runs', workflow?.id],
    `/v1/admin/workflows/${workflow?.id}/runs`,
    { enabled: !!workflow, refetchInterval: 5000 },
  );
  const runAction = useStudioMutation(
    (v: { path: string; body?: unknown }, tenant) =>
      api(v.path, { tenant, method: 'POST', body: v.body }),
    [['workflow-runs']],
  );
  const save = async () => {
    const checked = DefinitionSchema.safeParse(definition);
    if (!checked.success) {
      setValidation(
        checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
      return;
    }
    setValidation(null);
    await change.mutateAsync({
      path: workflow
        ? `/v1/admin/workflows/${workflow.id}`
        : `/v1/admin/brands/${brandId}/workflows`,
      method: workflow ? 'PUT' : 'POST',
      body: {
        name,
        definition: checked.data,
        ...(workflow ? { revision: workflow.revision } : {}),
      },
    });
    onClose();
  };
  const mutate = (suffix: string, body?: unknown, method?: 'PUT' | 'POST') =>
    change.mutate(
      { path: `/v1/admin/workflows/${workflow?.id}${suffix}`, body, ...(method ? { method } : {}) },
      { onSuccess: onClose },
    );
  return (
    <section className="flex flex-col gap-5">
      <LeaveGuard dirty={dirty} />
      <DiscardChangesDialog
        open={confirmClose}
        onKeep={() => setConfirmClose(false)}
        onDiscard={onClose}
      />
      <ActionError error={change.error ?? runAction.error} />
      {validation ? (
        <p role="alert" className="text-danger">
          {validation}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save().catch(() => undefined);
        }}
      >
        <fieldset disabled={!can('automations.manage')} className="flex min-w-0 flex-col gap-4">
          {!workflow ? (
            <SelectField
              id="workflow-template"
              label={t('agentic.template')}
              defaultValue=""
              onChange={(e) => {
                const template = e.target.value as WorkflowTemplate;
                setDefinition(
                  workflowTemplate(template, definition.agentId, t(`agentic.${template}`)),
                );
                if (!name) setName(t(`agentic.${template}`));
              }}
            >
              <option value="">—</option>
              {(['support', 'lead', 'billing', 'service', 'afterhours', 'handoff'] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`agentic.${value}`)}
                  </option>
                ),
              )}
            </SelectField>
          ) : null}
          <TextField
            id="workflow-name"
            label={t('agentic.name')}
            value={name}
            required
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="workflow-agent"
              label={t('agentic.coordinator')}
              hint={t(
                definition.trigger.type === 'manual'
                  ? 'agentic.manualCoordinatorHint'
                  : 'agentic.automaticCoordinatorHint',
              )}
              value={definition.agentId}
              required
              onChange={(e) => setDefinition({ ...definition, agentId: e.target.value })}
            >
              <option value="">—</option>
              {definition.agentId &&
              !agents.data?.items.some(
                (agent) => agent.brandId === brandId && agent.id === definition.agentId,
              ) ? (
                <option value={definition.agentId} disabled>
                  {t('agentic.unavailableCoordinator')}
                </option>
              ) : null}
              {agents.data?.items
                .filter((a) => a.brandId === brandId)
                .map((a) => (
                  <option
                    key={a.id}
                    value={a.id}
                    disabled={
                      a.status !== 'active' ||
                      a.publishedVersion === null ||
                      (definition.trigger.type !== 'manual' && !a.isDefault)
                    }
                  >
                    {a.name}
                  </option>
                ))}
            </SelectField>
            <SelectField
              id="workflow-trigger"
              label={t('agentic.trigger')}
              value={definition.trigger.type}
              onChange={(e) =>
                setDefinition({
                  ...definition,
                  trigger: { type: e.target.value as WorkflowDefinition['trigger']['type'] },
                })
              }
            >
              {(
                [
                  'manual',
                  'chat_started',
                  'customer_message',
                  'chat_closed',
                  'offline_message',
                ] as const
              ).map((type) => (
                <option key={type} value={type}>
                  {t(`agentic.triggers.${type}`)}
                </option>
              ))}
            </SelectField>
          </div>
          <SelectField
            id="workflow-entry"
            label={t('agentic.entry')}
            value={definition.entry}
            onChange={(e) => setDefinition({ ...definition, entry: e.target.value })}
          >
            {definition.steps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <ol className="flex flex-col gap-3">
            {definition.steps.map((step) => (
              <StepEditor
                key={`${step.id}-${step.type}`}
                step={step}
                steps={definition.steps}
                toolChoices={(tools.data?.items ?? []).map((tool) => ({
                  value: tool.id,
                  label:
                    tool.title +
                    (tool.status === 'enabled'
                      ? ''
                      : ` · ${t(tool.status === 'review' ? 'tools.permission.review' : 'tools.permission.off')}`),
                  disabled: tool.status !== 'enabled' || tool.stopped,
                }))}
                delegateChoices={[
                  ...(agents.data?.items ?? [])
                    .filter((agent) => agent.brandId === brandId && agent.id !== definition.agentId)
                    .map((agent) => ({
                      value: `agent:${agent.id}`,
                      label: `${t('agentic.internalSpecialist')}: ${agent.name}`,
                      disabled:
                        agent.status !== 'active' ||
                        !agent.publishedVersion ||
                        (!definition.allowedDelegateAgentIds.includes(agent.id) &&
                          definition.allowedDelegateAgentIds.length >= 8),
                    })),
                  ...(specialists.data?.items ?? []).map((connection) => ({
                    value: `connection:${connection.id}`,
                    label: `${t('agentic.externalSpecialist')}: ${connection.name}`,
                    disabled: !connection.enabled,
                  })),
                ]}
                change={(next) =>
                  setDefinition((current) => {
                    const steps = current.steps.map((existing) =>
                      existing.id === step.id ? next : existing,
                    );
                    let allowed = current.allowedDelegateAgentIds;
                    if (
                      next.type === 'delegate' &&
                      next.agentId &&
                      (step.type !== 'delegate' || step.agentId !== next.agentId) &&
                      !allowed.includes(next.agentId) &&
                      allowed.length < 8
                    )
                      allowed = [...allowed, next.agentId];
                    const delegationCount = steps.filter(
                      (candidate) => candidate.type === 'delegate',
                    ).length;
                    return {
                      ...current,
                      steps,
                      allowedDelegateAgentIds: allowed,
                      budget: {
                        ...current.budget,
                        maxDelegations: Math.max(
                          current.budget.maxDelegations,
                          Math.min(8, delegationCount),
                        ),
                        maxDepth: delegationCount
                          ? Math.max(current.budget.maxDepth, 1)
                          : current.budget.maxDepth,
                      },
                    };
                  })
                }
                remove={() => setDefinition(removeWorkflowStep(definition, step.id))}
              />
            ))}
          </ol>
          <Button
            type="button"
            variant="secondary"
            disabled={definition.steps.length >= 50}
            onClick={() => {
              const id = `step_${crypto.randomUUID().slice(0, 8)}`;
              setDefinition({
                ...definition,
                steps: [...definition.steps, newWorkflowStep('handoff', id, t('agentic.handoff'))],
              });
            }}
          >
            {t('agentic.addStep')}
          </Button>
          <details>
            <summary className="cursor-pointer text-sm">{t('agentic.advancedDefinition')}</summary>
            <div className="my-3 flex flex-col gap-3">
              <TextareaField
                id="workflow-definition"
                label={t('agentic.advancedDefinition')}
                hint={t('agentic.bindingsHint')}
                value={advancedText ?? JSON.stringify(definition, null, 2)}
                dir="ltr"
                rows={14}
                onChange={(event) => setAdvancedText(event.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={advancedText === null}
                onClick={() => {
                  try {
                    const checked = DefinitionSchema.safeParse(JSON.parse(advancedText ?? ''));
                    if (!checked.success) throw checked.error;
                    setDefinition(checked.data);
                    setAdvancedText(null);
                    setValidation(null);
                  } catch (error) {
                    setValidation(
                      error instanceof Error ? error.message : t('agentic.invalidJson'),
                    );
                  }
                }}
              >
                {t('agentic.applyDefinition')}
              </Button>
            </div>
          </details>
          <details>
            <summary className="cursor-pointer text-sm">{t('agentic.budgets')}</summary>
            <fieldset className="my-3 flex flex-col gap-3">
              <legend className="mb-2 text-sm font-medium">{t('agentic.delegateAllowlist')}</legend>
              {agents.data?.items
                .filter((a) => a.brandId === brandId && a.id !== definition.agentId)
                .map((a) => (
                  <CheckboxField
                    key={a.id}
                    id={`delegate-${a.id}`}
                    label={a.name}
                    checked={definition.allowedDelegateAgentIds.includes(a.id)}
                    onCheckedChange={(checked) =>
                      setDefinition({
                        ...definition,
                        allowedDelegateAgentIds: checked
                          ? [...definition.allowedDelegateAgentIds, a.id]
                          : definition.allowedDelegateAgentIds.filter((id) => id !== a.id),
                      })
                    }
                  />
                ))}
            </fieldset>
            <div className="grid gap-3 py-3 sm:grid-cols-2">
              {Object.entries(definition.budget).map(([key, value]) => (
                <TextField
                  key={key}
                  id={`budget-${key}`}
                  label={t(`agentic.budget.${key as keyof WorkflowDefinition['budget']}`)}
                  type="number"
                  min={key === 'maxDepth' || key === 'maxDelegations' ? 0 : 1}
                  max={
                    key === 'maxSteps'
                      ? 100
                      : key === 'maxDepth'
                        ? 3
                        : key === 'maxDelegations'
                          ? 8
                          : 86400
                  }
                  value={value}
                  onChange={(e) =>
                    setDefinition({
                      ...definition,
                      budget: { ...definition.budget, [key]: Number(e.target.value) },
                    })
                  }
                />
              ))}
            </div>
          </details>
          <div className="flex gap-2">
            <Button busy={change.isPending} disabled={advancedText !== null}>
              {t('agentic.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => (dirty ? setConfirmClose(true) : onClose())}
            >
              {t('app.close')}
            </Button>
          </div>
        </fieldset>
      </form>
      {workflow ? (
        <>
          <div className="flex flex-wrap gap-2">
            {can('automations.manage') ? (
              <>
                <Button
                  disabled={dirty}
                  title={dirty ? t('agentic.unsaved') : undefined}
                  busy={change.isPending}
                  onClick={() => mutate('/publish', { revision: workflow.revision })}
                >
                  {t('agentic.publish')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={!workflow.published}
                  onClick={() => mutate('/enabled', { enabled: !workflow.enabled }, 'PUT')}
                >
                  {t(workflow.enabled ? 'agentic.pause' : 'agentic.resume')}
                </Button>
              </>
            ) : null}
          </div>
          <h3 className="font-semibold">{t('agentic.versions')}</h3>
          <QueryState query={versions} label={t('app.loading')}>
            {(data) => (
              <ul className="flex flex-wrap gap-2">
                {data.items.map((v) => (
                  <li key={v.version}>
                    <Button
                      variant="secondary"
                      disabled={!can('automations.manage') || dirty}
                      onClick={() =>
                        mutate(`/versions/${v.version}/restore`, { revision: workflow.revision })
                      }
                    >
                      {t('agentic.restore')} {v.version}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
          <h3 className="font-semibold">{t('agentic.runs')}</h3>
          {can('automations.manage') && workflow.published && workflow.enabled ? (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                runAction.mutate(
                  {
                    path: `/v1/admin/workflows/${workflow.id}/runs`,
                    body: { conversationId, eventKey },
                  },
                  { onSuccess: () => setEventKey(newIdempotencyKey()) },
                );
              }}
            >
              <TextField
                id="run-conversation"
                label={t('agentic.conversationId')}
                value={conversationId}
                required
                onChange={(e) => {
                  setConversationId(e.target.value);
                  setEventKey(newIdempotencyKey());
                }}
              />
              <Button busy={runAction.isPending}>{t('agentic.startRun')}</Button>
            </form>
          ) : null}
          <QueryState query={runs} label={t('app.loading')}>
            {(data) => (
              <ul className="flex flex-col gap-3">
                {data.items.length === 0 ? <li>{t('agentic.empty')}</li> : null}
                {data.items.map((run) => (
                  <li key={run.id} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <bdi>{run.id}</bdi>
                      <strong>{t(`agentic.runStates.${run.state}`)}</strong>
                      <Link
                        to="/inbox/$conversationId"
                        params={{ conversationId: run.conversationId }}
                        className="text-link underline"
                      >
                        {t('nav.inbox')}
                      </Link>
                      {can('automations.manage') &&
                      ['queued', 'running', 'waiting', 'awaiting_approval'].includes(run.state) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            runAction.mutate({ path: `/v1/admin/workflow-runs/${run.id}/cancel` })
                          }
                        >
                          {t('agentic.cancel')}
                        </Button>
                      ) : null}
                    </div>
                    {run.reason ? <p className="text-sm">{run.reason}</p> : null}
                    {run.wakeAt ? (
                      <p className="text-sm">{new Date(run.wakeAt).toLocaleString()}</p>
                    ) : null}
                    <ol className="mt-2 space-y-1 text-sm text-text-secondary">
                      {run.steps.map((s) => (
                        <li key={`${s.stepId}-${s.startedAt}`}>
                          <bdi>{s.stepId}</bdi> · {t(`agentic.runStates.${s.state}`)} {s.summary}
                          {s.result ? (
                            <details className="mt-1 rounded-md bg-surface-sunken p-2">
                              <summary className="cursor-pointer">
                                {t('agentic.stepResult')} · {s.result.source}
                              </summary>
                              <p className="my-2 text-xs">{t('agentic.untrustedResult')}</p>
                              {s.result.text ? (
                                <p className="whitespace-pre-wrap break-words">
                                  <bdi>{s.result.text}</bdi>
                                </p>
                              ) : null}
                              {s.result.summary ? (
                                <p>
                                  <bdi>{s.result.summary}</bdi>
                                </p>
                              ) : null}
                              {s.result.passages?.map((passage) => (
                                <blockquote
                                  key={`${passage.documentId}-${passage.text}`}
                                  className="mt-2 border-s-2 border-border ps-3"
                                >
                                  <p className="whitespace-pre-wrap">
                                    <bdi>{passage.text}</bdi>
                                  </p>
                                  <cite className="break-all text-xs">
                                    <bdi>
                                      {passage.sourceId} / {passage.documentId}
                                    </bdi>
                                  </cite>
                                </blockquote>
                              ))}
                            </details>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </>
      ) : null}
    </section>
  );
}
export function WorkflowsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const { brands, active, chosen } = useChosenBrand(undefined);
  const [brand, setBrand] = useState<string | undefined>();
  const brandId = brand ?? chosen?.id ?? '';
  const list = useWorkflows(brandId, can('automations.read'));
  const [selected, setSelected] = useState<string | null | undefined>();
  const selectedWorkflow = list.data?.items.find((w) => w.id === selected) ?? null;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('agentic.workflows')} description={t('agentic.workflowDescription')} />
      <QueryState
        query={{
          data: brands.items,
          error: brands.error,
          isPending: brands.pending,
          isRefetching: brands.isRefetching,
          refetch: brands.refetch,
        }}
        label={t('app.loading')}
        permitted={can('automations.read')}
        isEmpty={() => !brandId}
        empty={<p>{t('tools.noBrands')}</p>}
      >
        {() => (
          <>
            {selected === undefined ? (
              <BrandPicker
                id="workflow-brand"
                label={t('nav.brands')}
                brands={active}
                value={brandId}
                onChange={(value) => {
                  setBrand(value);
                  setSelected(undefined);
                }}
              />
            ) : (
              <p className="text-sm font-medium">
                <bdi>{active.find((item) => item.id === brandId)?.name}</bdi>
              </p>
            )}
            {selected !== undefined ? (
              <WorkflowEditor
                key={`${brandId}-${selected ?? 'new'}-${selectedWorkflow?.revision ?? 0}`}
                workflow={selectedWorkflow}
                brandId={brandId}
                onClose={() => setSelected(undefined)}
              />
            ) : (
              <>
                <div>
                  {can('automations.manage') && brandId ? (
                    <Button onClick={() => setSelected(null)}>{t('agentic.create')}</Button>
                  ) : null}
                </div>
                <QueryState query={list} label={t('app.loading')}>
                  {(data) => (
                    <ul className="grid gap-3 md:grid-cols-2">
                      {data.items.length === 0 ? <li>{t('agentic.empty')}</li> : null}
                      {data.items.map((w) => (
                        <li key={w.id}>
                          <button
                            type="button"
                            onClick={() => setSelected(w.id)}
                            className="flex w-full flex-col gap-2 rounded-xl border border-border bg-surface p-4 text-start hover:bg-surface-sunken"
                          >
                            <span className="font-semibold">
                              <bdi>{w.name}</bdi>
                            </span>
                            <span className="text-sm text-text-secondary">
                              {t(
                                w.enabled
                                  ? 'agentic.connectionStates.active'
                                  : 'agentic.connectionStates.disabled',
                              )}{' '}
                              · {w.published ? `v${w.published.version}` : t('agentic.draft')}
                              {w.unpublishedChanges ? ` · ${t('agentic.unsavedChanges')}` : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </QueryState>
              </>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}
