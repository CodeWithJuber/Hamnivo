import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@hamnivo/ui/components/sheet';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import {
  BookOpenIcon,
  CircleOffIcon,
  HourglassIcon,
  LogInIcon,
  LogOutIcon,
  OctagonPauseIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UserCheckIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../components/AppDialog';
import { BrandPicker, useChosenBrand } from '../components/BrandPicker';
import {
  CheckboxField,
  ChoiceField,
  SelectField,
  TextareaField,
  TextField,
} from '../components/Fields';
import { PageHeader, Section } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { McpCatalogSheet } from '../components/tools/McpCatalogSheet';
import {
  EditServerDialog,
  RemoveServerDialog,
  SignInDialog,
  SignOutDialog,
  startMcpSignIn,
} from '../components/tools/McpServerDialogs';
import { directionOf, isLocale } from '../i18n';
import {
  type AiAction,
  type McpServer,
  type McpSyncResult,
  PERMISSION_TONES,
  permissionOf,
  type RiskClass,
  STATE_TONES,
  type ToolDefinition,
  type ToolPermission,
  toolKeys,
  useActionLog,
  useActionSettings,
  useBuiltinTools,
  useMcpServers,
  useTools,
} from '../lib/actions';
import { presetText, useMcpPresets } from '../lib/ai-power';
import { api, isApiError, newIdempotencyKey } from '../lib/api';
import { returnFocus, useOpener } from '../lib/focus';
import { formatDateTime } from '../lib/format';
import { useNames } from '../lib/names';
import { keys, useAgents, useStudioMutation } from '../lib/queries';
import { isCancelled } from '../lib/reauth';
import { useTenant } from '../lib/tenant';
import type { KillSwitch } from '../lib/types';
import type { ToolsSearch } from '../routes/_studio/tools';

const RISKS: RiskClass[] = ['read', 'write', 'money', 'irreversible'];
const highRisk = (risk: RiskClass) => risk === 'money' || risk === 'irreversible';

const PERMISSION_ICONS: Record<ToolPermission, ReactNode> = {
  automatic: <ZapIcon className="size-3.5" aria-hidden="true" />,
  customer: <UserCheckIcon className="size-3.5" aria-hidden="true" />,
  staff: <UserCheckIcon className="size-3.5" aria-hidden="true" />,
  review: <HourglassIcon className="size-3.5" aria-hidden="true" />,
  off: <CircleOffIcon className="size-3.5" aria-hidden="true" />,
  stopped: <OctagonPauseIcon className="size-3.5" aria-hidden="true" />,
};

/** Who may run a tool, with an icon and words (never colour alone). */
export function PermissionBadge({ tool }: { tool: ToolDefinition }) {
  const { t } = useTranslation();
  const permission = permissionOf(tool);
  return (
    <StatusBadge tone={PERMISSION_TONES[permission]} icon={PERMISSION_ICONS[permission]}>
      {t(`tools.permission.${permission}`)}
    </StatusBadge>
  );
}

export function ActionStateBadge({ state }: { state: AiAction['state'] }) {
  const { t } = useTranslation();
  return <StatusBadge tone={STATE_TONES[state]}>{t(`tools.states.${state}`)}</StatusBadge>;
}

function serverName(servers: McpServer[], id: string | null) {
  return servers.find((s) => s.id === id)?.label ?? id ?? '';
}

/** The capability table (board 13): tool, what it can do, permission and last change. */
function ToolTable({
  tools,
  servers,
  selected,
  onOpen,
}: {
  tools: ToolDefinition[];
  servers: McpServer[];
  selected: string | undefined;
  onOpen: (toolId: string) => void;
}) {
  const { t } = useTranslation();
  const names = useNames();
  const groups = useMemo(() => {
    const builtin = tools.filter((tool) => tool.source === 'builtin');
    const external = new Map<string, ToolDefinition[]>();
    for (const tool of tools.filter((x) => x.source === 'mcp')) {
      const key = tool.mcpServerId ?? '';
      external.set(key, [...(external.get(key) ?? []), tool]);
    }
    return [
      ...(builtin.length
        ? [{ id: 'builtin', title: t('tools.list.builtin'), items: builtin }]
        : []),
      ...[...external.entries()].map(([id, items]) => ({
        id,
        title: t('tools.list.from', { server: serverName(servers, id) }),
        items,
      })),
    ];
  }, [tools, servers, t]);

  // `relative` keeps the visually hidden header text inside the scroll area: without it, that
  // text sits at its place in the wide table and makes the whole page scroll sideways on a phone.
  return (
    <div
      className="relative overflow-x-auto rounded-xl border border-border"
      data-testid="tools-table"
    >
      <table className="w-full min-w-[40rem] text-sm">
        <caption className="sr-only">{t('tools.list.title')}</caption>
        <thead>
          <tr className="border-b border-border text-start text-xs text-text-secondary">
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('tools.list.columns.tool')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('tools.list.columns.scope')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('tools.list.columns.permission')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('tools.list.columns.changed')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              <span className="sr-only">{t('tools.list.columns.details')}</span>
            </th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.id}>
            <tr>
              <th
                scope="colgroup"
                colSpan={5}
                className="bg-surface-sunken px-3 py-1.5 text-start text-xs font-semibold text-text"
              >
                <bdi>{group.title}</bdi>
              </th>
            </tr>
            {group.items.map((tool) => (
              <tr
                key={tool.id}
                data-tool={tool.name}
                data-selected={tool.id === selected ? 'true' : undefined}
                className="border-b border-border last:border-b-0 data-[selected=true]:bg-surface-muted"
              >
                <td className="px-3 py-2.5 align-top">
                  <p className="font-medium text-text">
                    <bdi>{tool.title}</bdi>
                  </p>
                  <p className="line-clamp-2 text-xs text-text-secondary">
                    <bdi>{tool.description}</bdi>
                  </p>
                </td>
                <td className="px-3 py-2.5 align-top text-text">{t(`tools.risk.${tool.risk}`)}</td>
                <td className="px-3 py-2.5 align-top">
                  <div className="flex flex-col gap-1">
                    <span>
                      <PermissionBadge tool={tool} />
                    </span>
                    <span className="text-xs text-text-secondary">
                      {t(`tools.permissionHint.${permissionOf(tool)}`)}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5 align-top text-xs text-text-secondary">
                  <time dateTime={tool.updatedAt}>{formatDateTime(tool.updatedAt)}</time>
                  {tool.updatedBy ? (
                    <span className="block">
                      <bdi>{names.member(tool.updatedBy) ?? ''}</bdi>
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 align-top text-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onOpen(tool.id)}
                    aria-label={t('tools.list.open', { tool: tool.title })}
                    data-testid="open-tool"
                  >
                    {t('tools.list.columns.details')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

interface PolicyForm {
  status: ToolDefinition['status'];
  risk: RiskClass;
  approver: 'customer' | 'staff';
  autopilot: boolean;
  customerStepUp: boolean;
  requiredPermission: string;
  approvalMinutes: string;
  timeoutSeconds: string;
  maxOutputKb: string;
  egressHosts: string;
}

const toPolicyForm = (tool: ToolDefinition): PolicyForm => ({
  status: tool.status,
  risk: tool.risk,
  approver: tool.approver,
  autopilot: tool.autopilot,
  customerStepUp: tool.customerStepUp,
  requiredPermission: tool.requiredPermission ?? '',
  approvalMinutes: tool.approvalMinutes === null ? '' : String(tool.approvalMinutes),
  timeoutSeconds: String(tool.timeoutMs / 1000),
  maxOutputKb: String(Math.round(tool.maxOutputBytes / 1024)),
  egressHosts: tool.egressHosts.join('\n'),
});

function whole(value: string, min: number, max: number): number | null {
  const number = Number(value.trim());
  return value.trim() !== '' && Number.isInteger(number) && number >= min && number <= max
    ? number
    : null;
}

/** The changes a form makes to a tool, checked as the gateway will check them. */
function policyChanges(
  tool: ToolDefinition,
  form: PolicyForm,
  t: TFunction,
): { body: Record<string, unknown>; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  if (form.status !== tool.status) body.status = form.status;
  if (form.risk !== tool.risk) body.risk = form.risk;
  if (form.approver !== tool.approver) body.approver = form.approver;
  if (form.autopilot !== tool.autopilot) body.autopilot = form.autopilot;
  const stepUp = form.approver === 'customer' && form.customerStepUp;
  if (stepUp !== tool.customerStepUp) body.customerStepUp = stepUp;
  const permission = form.requiredPermission.trim() || null;
  if (permission !== tool.requiredPermission) body.requiredPermission = permission;
  if (form.approvalMinutes.trim() === '') {
    if (tool.approvalMinutes !== null) body.approvalMinutes = null;
  } else {
    const minutes = whole(form.approvalMinutes, 1, 7 * 24 * 60);
    if (minutes === null)
      errors['tool-approvalMinutes'] = t('tools.errors.number', { min: 1, max: 10_080 });
    else if (minutes !== tool.approvalMinutes) body.approvalMinutes = minutes;
  }
  const seconds = whole(form.timeoutSeconds, 1, 60);
  if (seconds === null) errors['tool-timeout'] = t('tools.errors.number', { min: 1, max: 60 });
  else if (seconds * 1000 !== tool.timeoutMs) body.timeoutMs = seconds * 1000;
  const kb = whole(form.maxOutputKb, 1, 256);
  if (kb === null) errors['tool-maxOutput'] = t('tools.errors.number', { min: 1, max: 256 });
  else if (kb * 1024 !== tool.maxOutputBytes) body.maxOutputBytes = kb * 1024;
  if (tool.source === 'mcp') {
    const hosts = form.egressHosts
      .split(/[\s,]+/)
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (hosts.length > 20) errors['tool-hosts'] = t('tools.errors.hosts');
    else if (JSON.stringify(hosts) !== JSON.stringify(tool.egressHosts)) body.egressHosts = hosts;
  }
  if (highRisk(form.risk) && form.approver !== 'staff') {
    errors['tool-approver'] = t('tools.errors.highRiskApprover');
  }
  if (highRisk(form.risk) && form.autopilot)
    errors['tool-autopilot'] = t('tools.errors.highRiskAutopilot');
  return { body, errors };
}

function ToolDetail({
  tool,
  servers,
  onSaved,
}: {
  tool: ToolDefinition;
  servers: McpServer[];
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const manage = can('tools.manage');
  const [form, setForm] = useState(() => toPolicyForm(tool));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopReason, setStopReason] = useState('');
  const recent = useActionLog({ toolId: tool.id, limit: 5 });
  const server = servers.find((s) => s.id === tool.mcpServerId);

  useEffect(() => {
    setForm(toPolicyForm(tool));
    setErrors({});
    setAttempted(false);
  }, [tool]);

  const save = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      api<ToolDefinition>(`/v1/admin/tools/${tool.id}`, {
        method: 'PATCH',
        body: { expectedRevision: tool.revision, ...body },
        tenant,
      }),
    [toolKeys.tools, toolKeys.actions],
  );
  const stop = useStudioMutation(
    (reason: string, tenant) =>
      api<KillSwitch>('/v1/admin/kill-switches', {
        method: 'POST',
        body: { scope: 'tool', targetId: tool.id, reason },
        tenant,
        idempotencyKey: newIdempotencyKey(),
      }),
    [toolKeys.tools, keys.killSwitches],
  );

  const set = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const submit = async (event: FormEvent, override?: Partial<PolicyForm>) => {
    event.preventDefault();
    setAttempted(true);
    setConflict(false);
    const next = { ...form, ...override };
    const { body, errors: found } = policyChanges(tool, next, t);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (Object.keys(body).length === 0) return;
    try {
      await save.mutateAsync(body);
      announce(t('tools.drawer.saved'));
      onSaved();
    } catch (error) {
      if (isApiError(error, 'VERSION_CONFLICT')) setConflict(true);
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) fields[`tool-${field.path}`] = field.message;
        setErrors(fields);
      }
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message }))
    : [];
  const permission = permissionOf(tool);

  return (
    <div className="flex flex-col gap-5">
      <section
        aria-labelledby="tool-permission"
        className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-3"
      >
        <h3 id="tool-permission" className="text-xs font-medium text-text-secondary">
          {t('tools.drawer.permission')}
        </h3>
        <div>
          <PermissionBadge tool={tool} />
        </div>
        <p className="text-sm text-text">{t(`tools.permissionHint.${permission}`)}</p>
        <p className="text-xs text-text-secondary">
          {t('tools.drawer.revision', { revision: tool.revision })}
          {tool.reviewedAt
            ? ` · ${t('tools.drawer.reviewed', { time: formatDateTime(tool.reviewedAt) })}`
            : ''}
        </p>
      </section>

      {tool.source === 'mcp' ? (
        <section aria-labelledby="tool-service" className="flex flex-col gap-2">
          <h3 id="tool-service" className="text-sm font-semibold text-text">
            {t('tools.drawer.service')}
          </h3>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-text-secondary">{t('tools.servers.columns.name')}</dt>
            <dd>
              <bdi>{server?.label ?? '—'}</bdi>{' '}
              {server ? (
                <StatusBadge tone={server.status === 'active' ? 'success' : 'neutral'}>
                  {t(`tools.servers.status.${server.status}`)}
                </StatusBadge>
              ) : null}
            </dd>
            <dt className="text-text-secondary">{t('tools.drawer.credential')}</dt>
            <dd>
              {server?.auth.kind === 'oauth' ? (
                <bdi>
                  {t('aiPower.mcp.auth.oauth', { host: server.auth.authorizationHost ?? '' })}
                </bdi>
              ) : (
                <bdi dir="ltr" className="font-mono text-xs">
                  {server?.credential?.masked ?? t('tools.drawer.noCredential')}
                </bdi>
              )}
            </dd>
            <dt className="text-text-secondary">{t('tools.drawer.hosts')}</dt>
            <dd className="min-w-0 break-all">
              <bdi dir="ltr" className="font-mono text-xs">
                {tool.egressHosts.join(', ') || '—'}
              </bdi>
            </dd>
          </dl>
          {tool.remoteDescription ? (
            <figure className="flex flex-col gap-1 rounded-lg border border-dashed border-border p-3">
              <figcaption className="text-xs font-medium text-text-secondary">
                {t('tools.drawer.remote')}
              </figcaption>
              <blockquote className="text-sm text-text">
                <bdi>{tool.remoteDescription}</bdi>
              </blockquote>
              <p className="text-xs text-text-secondary">{t('tools.drawer.remoteNote')}</p>
            </figure>
          ) : null}
        </section>
      ) : null}

      {tool.status === 'review' && manage ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-sm text-text">{t('tools.drawer.reviewNote')}</p>
          <Button
            className="self-start"
            busy={save.isPending}
            onClick={(event) => void submit(event, { status: 'enabled' })}
            data-testid="review-tool"
          >
            {t('tools.drawer.review')}
          </Button>
        </div>
      ) : null}

      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <h3 className="text-sm font-semibold text-text">{t('tools.drawer.settings')}</h3>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        {tool.status !== 'review' ? (
          <CheckboxField
            id="tool-status"
            label={t('tools.drawer.on')}
            hint={t('tools.drawer.onHint')}
            checked={form.status === 'enabled'}
            onCheckedChange={(on) => set('status', on ? 'enabled' : 'disabled')}
            disabled={!manage}
          />
        ) : null}
        <SelectField
          id="tool-risk"
          label={t('tools.drawer.risk')}
          value={form.risk}
          onChange={(event) => set('risk', event.target.value as RiskClass)}
          options={RISKS.map((risk) => ({ value: risk, label: t(`tools.risk.${risk}`) }))}
          disabled={!manage}
        />
        <ChoiceField
          id="tool-approver"
          legend={t('tools.drawer.approver')}
          value={form.approver}
          onValueChange={(value) => set('approver', value as 'customer' | 'staff')}
          choices={[
            {
              value: 'customer',
              label: t('tools.drawer.approverCustomer'),
              hint: t('tools.drawer.approverCustomerHint'),
            },
            {
              value: 'staff',
              label: t('tools.drawer.approverStaff'),
              hint: t('tools.drawer.approverStaffHint'),
            },
          ]}
          error={errors['tool-approver']}
          disabled={!manage}
        />
        <CheckboxField
          id="tool-autopilot"
          label={t('tools.drawer.autopilot')}
          hint={errors['tool-autopilot'] ?? t('tools.drawer.autopilotHint')}
          checked={form.autopilot}
          onCheckedChange={(on) => set('autopilot', on)}
          disabled={!manage || highRisk(form.risk)}
        />
        {form.approver === 'customer' ? (
          <CheckboxField
            id="tool-customerStepUp"
            label={t('tools.drawer.stepUp')}
            hint={t('tools.drawer.stepUpHint')}
            checked={form.customerStepUp}
            onCheckedChange={(on) => set('customerStepUp', on)}
            disabled={!manage}
          />
        ) : null}
        <TextField
          id="tool-requiredPermission"
          label={t('tools.drawer.requiredPermission')}
          hint={t('tools.drawer.requiredPermissionHint')}
          labelNote={t('tools.optional')}
          value={form.requiredPermission}
          dir="ltr"
          spellCheck={false}
          onChange={(event) => set('requiredPermission', event.target.value)}
          error={errors['tool-requiredPermission']}
          disabled={!manage}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            id="tool-approvalMinutes"
            label={t('tools.drawer.approvalMinutes')}
            hint={t('tools.drawer.approvalMinutesHint')}
            inputMode="numeric"
            value={form.approvalMinutes}
            onChange={(event) => set('approvalMinutes', event.target.value)}
            error={errors['tool-approvalMinutes']}
            disabled={!manage}
          />
          <TextField
            id="tool-timeout"
            label={t('tools.drawer.timeout')}
            inputMode="numeric"
            value={form.timeoutSeconds}
            onChange={(event) => set('timeoutSeconds', event.target.value)}
            error={errors['tool-timeout'] ?? errors['tool-timeoutMs']}
            disabled={!manage}
          />
          <TextField
            id="tool-maxOutput"
            label={t('tools.drawer.maxOutput')}
            inputMode="numeric"
            value={form.maxOutputKb}
            onChange={(event) => set('maxOutputKb', event.target.value)}
            error={errors['tool-maxOutput'] ?? errors['tool-maxOutputBytes']}
            disabled={!manage}
          />
        </div>
        {tool.source === 'mcp' ? (
          <TextareaField
            id="tool-hosts"
            label={t('tools.drawer.hosts')}
            hint={t('tools.drawer.hostsHint')}
            value={form.egressHosts}
            dir="ltr"
            rows={3}
            spellCheck={false}
            onChange={(event) => set('egressHosts', event.target.value)}
            error={errors['tool-hosts'] ?? errors['tool-egressHosts']}
            disabled={!manage}
          />
        ) : null}
        {conflict ? (
          <p role="alert" className="text-sm font-medium text-text">
            {t('tools.drawer.conflict')}
          </p>
        ) : null}
        <ActionError
          error={
            isCancelled(save.error) || isApiError(save.error, 'VERSION_CONFLICT')
              ? null
              : save.error
          }
        />
        {manage ? (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={save.isPending} data-testid="save-tool">
              {t('tools.drawer.save')}
            </Button>
            {!tool.stopped ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setStopReason('');
                  setStopOpen(true);
                }}
              >
                <OctagonPauseIcon aria-hidden="true" />
                {t('tools.drawer.stop')}
              </Button>
            ) : (
              <Button asChild variant="secondary">
                <Link to="/stop-ai">{t('tools.drawer.stopped')}</Link>
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-text-secondary">{t('tools.noManage')}</p>
        )}
      </form>

      <section aria-labelledby="tool-recent" className="flex flex-col gap-2">
        <h3 id="tool-recent" className="text-sm font-semibold text-text">
          {t('tools.drawer.recent')}
        </h3>
        <QueryState query={recent} label={t('tools.log.loading')}>
          {(page) =>
            page.items.length === 0 ? (
              <p className="text-sm text-text-secondary">{t('tools.log.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {page.items.map((action) => (
                  <li
                    key={action.id}
                    className="flex flex-col gap-1 rounded-lg border border-border p-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <ActionStateBadge state={action.state} />
                      <time dateTime={action.createdAt} className="text-xs text-text-secondary">
                        {formatDateTime(action.createdAt)}
                      </time>
                    </div>
                    <p className="text-sm text-text">
                      <bdi>{action.summary}</bdi>
                    </p>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryState>
      </section>

      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title={t('tools.drawer.stopTitle', { tool: tool.title })}
        confirmLabel={t('tools.drawer.stop')}
        variant="destructive-solid"
        onConfirm={async () => {
          if (stopReason.trim().length < 3) throw new Error(t('tools.errors.reason'));
          await stop.mutateAsync(stopReason.trim());
          announce(t('tools.drawer.stoppedNow', { tool: tool.title }), 'assertive');
        }}
      >
        <p>{t('tools.drawer.stopBody')}</p>
        <TextareaField
          id="tool-stop-reason"
          label={t('tools.drawer.stopReason')}
          value={stopReason}
          maxLength={500}
          onChange={(event) => setStopReason(event.target.value)}
        />
      </ConfirmDialog>
    </div>
  );
}

function AddToolDialog({
  open,
  onOpenChange,
  brandId,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandId: string;
  existing: ToolDefinition[];
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const builtins = useBuiltinTools();
  const [choice, setChoice] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const added = new Set(existing.map((tool) => tool.builtin));
  const options = (builtins.data?.items ?? []).map((tool) => ({
    value: tool.key,
    label: `${tool.title}${tool.demo ? ` (${t('tools.add.demo')})` : ''}${
      added.has(tool.key)
        ? ` · ${t('tools.add.added')}`
        : !tool.available
          ? ` · ${t('tools.add.unavailable')}`
          : ''
    }`,
    disabled: added.has(tool.key) || !tool.available,
  }));
  const chosen = builtins.data?.items.find((tool) => tool.key === choice);

  useEffect(() => {
    if (!open) return;
    setChoice('');
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const create = useStudioMutation(
    (builtin: string, tenant) =>
      api<ToolDefinition>('/v1/admin/tools', {
        method: 'POST',
        body: { brandId, builtin },
        tenant,
        idempotencyKey,
      }),
    [toolKeys.tools],
  );

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
      title={t('tools.add.title')}
      description={t('tools.add.description')}
      testId="add-tool-dialog"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!choice) return;
          try {
            const tool = await create.mutateAsync(choice);
            announce(t('tools.add.done', { tool: tool.title }));
            onOpenChange(false);
          } catch {
            // Shown below.
          }
        }}
      >
        <SelectField
          id="add-tool"
          label={t('tools.add.label')}
          value={choice}
          placeholder={t('tools.add.choose')}
          onChange={(event) => setChoice(event.target.value)}
          options={options}
        />
        {chosen ? (
          <p className="text-sm text-text-secondary">
            <bdi>{chosen.description}</bdi>
          </p>
        ) : null}
        <ActionError error={isCancelled(create.error) ? null : create.error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={create.isPending} disabled={!choice}>
            {t('tools.add.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function ConnectServerDialog({
  open,
  onOpenChange,
  brandId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandId: string;
}) {
  const { t, i18n } = useTranslation();
  const announce = useAnnouncer();
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [presetId, setPresetId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const presets = useMcpPresets();
  const preset = presets.data?.items.find((item) => item.id === presetId);

  useEffect(() => {
    if (!open) return;
    setLabel('');
    setUrl('');
    setToken('');
    setPresetId('');
    setErrors({});
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const choosePreset = (id: string) => {
    setPresetId(id);
    const chosenPreset = presets.data?.items.find((item) => item.id === id);
    if (!chosenPreset) return;
    setLabel(chosenPreset.name);
    setUrl(chosenPreset.url);
    setErrors({});
  };

  const signInNow = useStudioMutation(
    (serverId: string, tenant) => startMcpSignIn(serverId, {}, tenant),
    [],
  );

  const connect = useStudioMutation(
    (body: { label: string; url: string; token?: string }, tenant) =>
      api<McpServer>('/v1/admin/mcp-servers', {
        method: 'POST',
        body: { brandId, ...body },
        tenant,
        idempotencyKey,
      }),
    [toolKeys.servers],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!label.trim()) next['server-label'] = t('tools.errors.label');
    try {
      const parsed = new URL(url.trim());
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('protocol');
    } catch {
      next['server-url'] = t('tools.errors.url');
    }
    if (token && token.trim().length < 8) next['server-token'] = t('tools.errors.token');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      const server = await connect.mutateAsync({
        label: label.trim(),
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      announce(t('tools.servers.connected', { name: server.label }));
      onOpenChange(false);
      // A service that signs in with the browser: go there now. If that does not work, the
      // server's card has the Sign in button.
      if (preset?.auth === 'oauth' && !token.trim()) {
        await signInNow.mutateAsync(server.id).catch(() => undefined);
      }
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) fields[`server-${field.path}`] = field.message;
        setErrors(fields);
      }
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!connect.isPending) onOpenChange(next);
      }}
      title={t('tools.servers.dialogTitle')}
      description={t('tools.servers.dialogDescription')}
      testId="connect-server-dialog"
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {presets.data && presets.data.items.length > 0 ? (
          <>
            <SelectField
              id="server-preset"
              label={t('aiPower.mcp.preset.label')}
              hint={t('aiPower.mcp.preset.hint')}
              value={presetId}
              placeholder={t('aiPower.mcp.preset.other')}
              onChange={(event) => choosePreset(event.target.value)}
              options={presets.data.items.map((item) => ({ value: item.id, label: item.name }))}
            />
            {preset ? (
              <div
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-3 text-sm"
                data-testid="preset-details"
              >
                <p className="text-text">
                  <bdi>{presetText(t, i18n, 'summaries', preset)}</bdi>
                </p>
                <p className="text-text-secondary">{t(`aiPower.mcp.preset.auth.${preset.auth}`)}</p>
                {preset.note ? (
                  <p className="text-xs text-text-secondary">
                    <bdi>{presetText(t, i18n, 'notes', preset)}</bdi>
                  </p>
                ) : null}
                <p className="text-xs text-text-secondary">
                  <a
                    href={preset.docsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-link underline"
                  >
                    {t('aiPower.mcp.preset.docs')}
                  </a>
                  {' · '}
                  {t('aiPower.mcp.preset.verified', { date: preset.verifiedOn })}
                </p>
              </div>
            ) : null}
          </>
        ) : null}
        <TextField
          id="server-label"
          label={t('tools.servers.label')}
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          error={errors['server-label']}
        />
        <TextField
          id="server-url"
          label={t('tools.servers.url')}
          hint={t('tools.servers.urlHint')}
          value={url}
          dir="ltr"
          type="url"
          spellCheck={false}
          onChange={(event) => setUrl(event.target.value)}
          error={errors['server-url']}
        />
        <TextField
          id="server-token"
          label={t('tools.servers.token')}
          labelNote={t('tools.optional')}
          hint={t('tools.servers.tokenHint')}
          value={token}
          dir="ltr"
          type="password"
          autoComplete="off"
          onChange={(event) => setToken(event.target.value)}
          error={errors['server-token']}
        />
        <ActionError
          error={
            isCancelled(connect.error) || isApiError(connect.error, 'VALIDATION_FAILED')
              ? null
              : connect.error
          }
        />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={connect.isPending}>
            {t('tools.servers.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function ServerRow({ server }: { server: McpServer }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const [result, setResult] = useState<McpSyncResult | null>(null);
  const sync = useStudioMutation(
    (_: undefined, tenant) =>
      api<McpSyncResult>(`/v1/admin/mcp-servers/${server.id}/sync`, { method: 'POST', tenant }),
    [toolKeys.servers, toolKeys.tools],
  );
  const toggle = useStudioMutation(
    (status: 'active' | 'disabled', tenant) =>
      api<McpServer>(`/v1/admin/mcp-servers/${server.id}`, {
        method: 'PATCH',
        body: { status },
        tenant,
      }),
    [toolKeys.servers],
  );
  const [dialog, setDialog] = useState<'edit' | 'remove' | 'signIn' | 'signOut' | 'catalog' | null>(
    null,
  );
  const host = (() => {
    try {
      return new URL(server.url).host;
    } catch {
      return server.url;
    }
  })();
  const needsSignIn = server.auth.kind === 'oauth' && server.auth.status === 'needs_reconnect';
  const authText =
    server.auth.kind === 'oauth'
      ? needsSignIn
        ? t('aiPower.mcp.auth.needsReconnect')
        : t('aiPower.mcp.auth.oauth', { host: server.auth.authorizationHost ?? '' })
      : server.auth.kind === 'token'
        ? t('aiPower.mcp.auth.token', { masked: server.credential?.masked ?? '' })
        : t('aiPower.mcp.auth.none');
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-server={server.label}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <p className="font-medium text-text">
            <bdi>{server.label}</bdi>
          </p>
          <p className="text-xs text-text-secondary">
            <bdi dir="ltr" className="font-mono">
              {host}
            </bdi>
          </p>
        </div>
        <StatusBadge tone={server.status === 'active' ? 'success' : 'neutral'}>
          {t(`tools.servers.status.${server.status}`)}
        </StatusBadge>
      </div>
      <p className="text-sm text-text">
        {t('tools.servers.toolCount', { total: server.toolCount })}
        {server.pendingReview > 0
          ? ` · ${t('tools.servers.pending', { total: server.pendingReview })}`
          : ''}
      </p>
      <p className="text-xs text-text-secondary">
        {server.lastSyncedAt
          ? t('tools.servers.checked', { time: formatDateTime(server.lastSyncedAt) })
          : t('tools.servers.never')}
      </p>
      <p
        className={`text-xs ${needsSignIn ? 'font-medium text-danger' : 'text-text-secondary'}`}
        data-testid="server-auth"
      >
        <bdi>{authText}</bdi>
        {server.auth.kind === 'oauth' && !needsSignIn && server.auth.expiresAt
          ? ` · ${t('aiPower.mcp.auth.expires', { time: formatDateTime(server.auth.expiresAt) })}`
          : ''}
      </p>
      {server.lastError ? (
        <p className="text-sm text-danger" role="alert">
          {t('tools.servers.lastError', { error: server.lastError })}
        </p>
      ) : null}
      {result ? (
        <p className="text-sm text-text" role="status">
          {t('tools.servers.synced', {
            added: result.added.length,
            changed: result.changed.length,
            removed: result.removed.length,
          })}
          {result.skipped.length
            ? ` ${t('tools.servers.skipped', { total: result.skipped.length })}`
            : ''}
        </p>
      ) : null}
      <ActionError error={isCancelled(sync.error) ? null : (sync.error ?? toggle.error)} />
      <div className="flex flex-wrap gap-2">
        {can('tools.manage') ? (
          <Button
            variant="secondary"
            size="sm"
            busy={sync.isPending}
            disabled={server.status !== 'active'}
            onClick={async () => {
              try {
                const synced = await sync.mutateAsync();
                setResult(synced);
                announce(
                  t('tools.servers.synced', {
                    added: synced.added.length,
                    changed: synced.changed.length,
                    removed: synced.removed.length,
                  }),
                );
              } catch {
                // Shown above.
              }
            }}
            aria-label={t('tools.servers.syncLabel', { name: server.label })}
          >
            <RefreshCwIcon aria-hidden="true" />
            {t('tools.servers.sync')}
          </Button>
        ) : null}
        {can('tools.manage') ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              busy={toggle.isPending}
              onClick={() =>
                void toggle
                  .mutateAsync(server.status === 'active' ? 'disabled' : 'active')
                  .catch(() => undefined)
              }
            >
              {server.status === 'active' ? t('tools.servers.turnOff') : t('tools.servers.turnOn')}
            </Button>
            {server.auth.kind === 'oauth' && !needsSignIn ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDialog('signOut')}
                aria-label={t('aiPower.mcp.actions.signOutLabel', { name: server.label })}
              >
                <LogOutIcon aria-hidden="true" />
                {t('aiPower.mcp.actions.signOut')}
              </Button>
            ) : null}
            {server.status === 'active' && (server.auth.kind !== 'oauth' || needsSignIn) ? (
              <Button
                variant={needsSignIn ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setDialog('signIn')}
                aria-label={t('aiPower.mcp.actions.signInLabel', { name: server.label })}
                data-testid="sign-in"
              >
                <LogInIcon aria-hidden="true" />
                {needsSignIn
                  ? t('aiPower.mcp.actions.signInAgain')
                  : t('aiPower.mcp.actions.signIn')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDialog('edit')}
              aria-label={t('aiPower.mcp.actions.editLabel', { name: server.label })}
              data-testid="edit-server"
            >
              <PencilIcon aria-hidden="true" />
              {t('aiPower.mcp.actions.edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDialog('remove')}
              aria-label={t('aiPower.mcp.actions.removeLabel', { name: server.label })}
              data-testid="remove-server"
            >
              <Trash2Icon aria-hidden="true" />
              {t('aiPower.mcp.actions.remove')}
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDialog('catalog')}
          aria-label={t('aiPower.mcp.actions.catalogLabel', { name: server.label })}
          data-testid="open-catalog"
        >
          <BookOpenIcon aria-hidden="true" />
          {t('aiPower.mcp.actions.catalog')}
        </Button>
      </div>
      <SignInDialog
        server={server}
        open={dialog === 'signIn'}
        onOpenChange={(o) => setDialog(o ? 'signIn' : null)}
      />
      <SignOutDialog
        server={server}
        open={dialog === 'signOut'}
        onOpenChange={(o) => setDialog(o ? 'signOut' : null)}
      />
      <EditServerDialog
        server={server}
        open={dialog === 'edit'}
        onOpenChange={(o) => setDialog(o ? 'edit' : null)}
      />
      <RemoveServerDialog
        server={server}
        open={dialog === 'remove'}
        onOpenChange={(o) => setDialog(o ? 'remove' : null)}
      />
      <McpCatalogSheet
        server={server}
        open={dialog === 'catalog'}
        onOpenChange={(o) => setDialog(o ? 'catalog' : null)}
      />
    </li>
  );
}

function SettingsForm() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const settings = useActionSettings();
  const [enabled, setEnabled] = useState(true);
  const [limit, setLimit] = useState('200');
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.autopilotEnabled);
    setLimit(String(settings.data.dailyAutopilotLimit));
  }, [settings.data]);
  const save = useStudioMutation(
    (body: { autopilotEnabled: boolean; dailyAutopilotLimit: number }, tenant) =>
      api('/v1/admin/action-settings', { method: 'PUT', body, tenant }),
    [toolKeys.settings],
  );
  const manage = can('tools.manage');
  return (
    <QueryState query={settings} label={t('tools.settings.loading')}>
      {() => (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={async (event) => {
            event.preventDefault();
            const number = whole(limit, 0, 100_000);
            if (number === null) {
              setError(t('tools.errors.number', { min: 0, max: 100_000 }));
              return;
            }
            setError(undefined);
            try {
              await save.mutateAsync({ autopilotEnabled: enabled, dailyAutopilotLimit: number });
              announce(t('tools.settings.saved'));
            } catch {
              // Shown below.
            }
          }}
        >
          <CheckboxField
            id="autopilot-enabled"
            label={t('tools.settings.enabled')}
            hint={t('tools.settings.enabledHint')}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={!manage}
          />
          <div className="max-w-xs">
            <TextField
              id="autopilot-limit"
              label={t('tools.settings.limit')}
              hint={t('tools.settings.limitHint')}
              inputMode="numeric"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              error={error}
              disabled={!manage}
            />
          </div>
          <ActionError error={isCancelled(save.error) ? null : save.error} />
          {manage ? (
            <Button type="submit" className="self-start" busy={save.isPending}>
              {t('tools.settings.save')}
            </Button>
          ) : null}
        </form>
      )}
    </QueryState>
  );
}

function ActionLog({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const log = useActionLog({ brandId, limit: 20 });
  return (
    <QueryState
      query={log}
      label={t('tools.log.loading')}
      isEmpty={(page) => page.items.length === 0}
      empty={<p className="text-sm text-text-secondary">{t('tools.log.empty')}</p>}
    >
      {(page) => (
        <div className="relative overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[36rem] text-sm" data-testid="action-log">
            <caption className="sr-only">{t('tools.log.title')}</caption>
            <thead>
              <tr className="border-b border-border text-xs text-text-secondary">
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('tools.log.columns.when')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('tools.log.columns.action')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('tools.log.columns.state')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('tools.log.columns.decided')}
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((action) => (
                <tr key={action.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 align-top whitespace-nowrap text-text-secondary">
                    <time dateTime={action.createdAt}>{formatDateTime(action.createdAt)}</time>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <p className="text-text">
                      <bdi>{action.summary}</bdi>
                    </p>
                    <p className="text-xs text-text-secondary">
                      <bdi>{action.tool.title}</bdi>
                      {can('conversations.read') ? (
                        <>
                          {' · '}
                          <Link
                            to="/inbox/$conversationId"
                            params={{ conversationId: action.conversationId }}
                            className="text-link underline"
                          >
                            {t('tools.log.open')}
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <ActionStateBadge state={action.state} />
                    {action.reason ? (
                      <p className="mt-1 text-xs text-text-secondary">
                        <bdi>{action.reason}</bdi>
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-text-secondary">
                    {action.decision
                      ? `${t(`tools.log.by.${action.decision.approverKind}`)} · ${formatDateTime(action.decision.at)}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </QueryState>
  );
}

/**
 * Tools and permissions (G07, G08, G15, D10; board 13): what the AI agents of a brand may use,
 * who approves each kind of action, the connected MCP services and their reviewed tools, the
 * budgets for automatic actions, and what the AI actually proposed and did.
 */
export function ToolsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useTenant();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/tools' });
  const { brands, active, chosen } = useChosenBrand(search.brand);
  const brandId = chosen?.id;
  const tools = useTools(brandId);
  const servers = useMcpServers(brandId);
  const agents = useAgents();
  const [addOpen, setAddOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const dir = directionOf(isLocale(i18n.language) ? i18n.language : 'en');
  const toolOpener = useOpener(Boolean(search.tool));
  const manage = can('tools.manage');
  const agent = (agents.data?.items ?? []).find(
    (a) => a.brandId === brandId && a.isDefault && a.status === 'active',
  );
  const selected = tools.data?.items.find((tool) => tool.id === search.tool);

  const go = (next: ToolsSearch) => void navigate({ to: '/tools', search: next });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('tools.title')}
        description={t('tools.description')}
        actions={
          manage && brandId ? (
            <Button onClick={() => setAddOpen(true)} data-testid="add-tool">
              <PlusIcon aria-hidden="true" />
              {t('tools.add.button')}
            </Button>
          ) : null
        }
      />
      <BrandPicker
        id="tools-brand"
        label={t('tools.brand')}
        brands={active}
        value={brandId ?? ''}
        onChange={(id) => go({ brand: id })}
      />
      {!brands.pending && !brandId ? (
        <p className="text-sm text-text-secondary">{t('tools.noBrands')}</p>
      ) : null}
      {brandId ? (
        <>
          <div
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-4 text-sm"
            data-testid="tools-agent"
          >
            <span className="text-text-secondary">{t('tools.agent')}</span>
            {agent ? (
              <>
                <span className="font-medium text-text">
                  <bdi>{agent.name}</bdi>
                </span>
                <StatusBadge tone={agent.publishedVersion ? 'success' : 'neutral'}>
                  {agent.publishedVersion
                    ? t('tools.agentPublished', { version: agent.publishedVersion })
                    : t('tools.agentDraft')}
                </StatusBadge>
                {can('agents.manage') ? (
                  <Button asChild variant="secondary" size="sm">
                    <Link to="/agents/$agentId" params={{ agentId: agent.id }} hash="tools-title">
                      {t('tools.editGrants')}
                    </Link>
                  </Button>
                ) : null}
              </>
            ) : (
              <span className="text-text-secondary">{t('tools.agentNone')}</span>
            )}
          </div>

          <Section
            id="tools-list"
            title={t('tools.list.title')}
            description={t('tools.list.description')}
          >
            {!manage ? <p className="text-sm text-text-secondary">{t('tools.noManage')}</p> : null}
            <QueryState
              query={tools}
              label={t('tools.loading')}
              permitted={can('tools.read')}
              isEmpty={(data) => data.items.length === 0}
              empty={
                <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-4">
                  <WrenchIcon className="size-5 text-text-muted" aria-hidden="true" />
                  <p className="font-medium text-text">{t('tools.list.emptyTitle')}</p>
                  <p className="text-sm text-text-secondary">{t('tools.list.emptyDescription')}</p>
                </div>
              }
            >
              {(data) => (
                <ToolTable
                  tools={data.items}
                  servers={servers.data?.items ?? []}
                  selected={search.tool}
                  onOpen={(toolId) => go({ brand: brandId, tool: toolId })}
                />
              )}
            </QueryState>
          </Section>

          <Section
            id="tools-servers"
            title={t('tools.servers.title')}
            description={t('tools.servers.description')}
            actions={
              manage ? (
                <Button variant="secondary" onClick={() => setConnectOpen(true)}>
                  <PlusIcon aria-hidden="true" />
                  {t('tools.servers.connect')}
                </Button>
              ) : null
            }
          >
            <QueryState
              query={servers}
              label={t('tools.servers.loading')}
              isEmpty={(data) => data.items.length === 0}
              empty={<p className="text-sm text-text-secondary">{t('tools.servers.empty')}</p>}
            >
              {(data) => (
                <ul className="grid gap-3 md:grid-cols-2" data-testid="mcp-servers">
                  {data.items.map((server) => (
                    <ServerRow key={server.id} server={server} />
                  ))}
                </ul>
              )}
            </QueryState>
          </Section>

          <Section
            id="tools-settings"
            title={t('tools.settings.title')}
            description={t('tools.settings.description')}
          >
            <SettingsForm />
          </Section>

          <Section
            id="tools-log"
            title={t('tools.log.title')}
            description={t('tools.log.description')}
          >
            <ActionLog brandId={brandId} />
          </Section>

          <AddToolDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            brandId={brandId}
            existing={tools.data?.items ?? []}
          />
          <ConnectServerDialog open={connectOpen} onOpenChange={setConnectOpen} brandId={brandId} />
        </>
      ) : null}

      <Sheet
        open={Boolean(search.tool)}
        onOpenChange={(next) => {
          if (!next) go(brandId ? { brand: brandId } : {});
        }}
      >
        <SheetContent
          side={dir === 'rtl' ? 'left' : 'right'}
          showCloseButton={false}
          className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg"
          data-testid="tool-sheet"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus(toolOpener.current);
          }}
        >
          <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-border bg-bg px-4 py-3">
            <div className="flex min-w-0 flex-col">
              <SheetTitle className="text-lg">
                <bdi>{selected?.title ?? t('tools.loading')}</bdi>
              </SheetTitle>
              <SheetDescription className="text-xs">
                <bdi>{selected?.description ?? ''}</bdi>
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('app.close')}>
                <XIcon aria-hidden="true" />
              </Button>
            </SheetClose>
          </div>
          <div className="p-4">
            {selected ? (
              <ToolDetail
                tool={selected}
                servers={servers.data?.items ?? []}
                onSaved={() => undefined}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
