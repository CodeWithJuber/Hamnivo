import { Button } from '@hamnivo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@hamnivo/ui/components/dropdown-menu';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, DownloadIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../../components/Fields';
import { ActionError, ErrorPanel, ListSkeleton } from '../../components/States';
import { type AuditQuery, accessKeys, auditSearch, useAuditLog } from '../../lib/access';
import { auditActionLabel } from '../../lib/access-text';
import { ApiError, api } from '../../lib/api';
import { API_BASE } from '../../lib/config';
import { formatDateTime, formatNumber } from '../../lib/format';
import { useMembers } from '../../lib/queries';
import { isCancelled, withReauth } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { AuditEvent, AuditVerification, Problem } from '../../lib/types';

const OUTCOME_TONE: Record<AuditEvent['outcome'], StatusTone> = {
  success: 'success',
  denied: 'warning',
  failed: 'danger',
};

const ACTIONS = [
  'member.suspended',
  'member.restored',
  'member.removed',
  'invitation.created',
  'invitation.accepted',
  'grant.created',
  'grant.revoked',
  'grant.replaced',
  'role.created',
  'role.updated',
  'role.archived',
  'audit.exported',
  'sso.connection_updated',
  'support.approved',
  'support.accessed',
];

const startOfDay = (day: string) => (day ? new Date(`${day}T00:00:00`).toISOString() : undefined);
const endOfDay = (day: string) => (day ? new Date(`${day}T23:59:59.999`).toISOString() : undefined);

/** Downloads the export (A09); the gateway records it before sending the first line. */
async function downloadExport(tenantId: string, format: 'csv' | 'ndjson', filters: AuditQuery) {
  const query = auditSearch(filters);
  query.set('format', format);
  const response = await fetch(`${API_BASE}/v1/admin/audit/export?${query}`, {
    headers: { 'x-hamnivo-tenant': tenantId },
    credentials: 'include',
  });
  if (!response.ok) {
    let problem: Problem | null = null;
    try {
      problem = (await response.json()) as Problem;
    } catch {
      problem = null;
    }
    throw new ApiError(
      response.status,
      problem?.code ?? (response.status === 403 ? 'SCOPE_DENIED' : 'UNKNOWN'),
      problem,
    );
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `hamnivo-audit.${format}`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The audit log (A09): filters, integrity check and export, newest entries first. */
export function AuditTab() {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { tenantId, can } = useTenant();
  const members = useMembers();
  const [draft, setDraft] = useState({ action: '', actorId: '', targetId: '', from: '', to: '' });
  const [filters, setFilters] = useState<AuditQuery>({});
  const log = useAuditLog(filters);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const [exported, setExported] = useState(false);
  const client = useQueryClient();
  const verify = useQuery({
    queryKey: [tenantId, 'audit', 'verify'],
    queryFn: () => api<AuditVerification>('/v1/admin/audit/verify', { tenant: tenantId }),
    enabled: false,
    meta: { studio: true },
  });
  const names = new Map((members.data?.items ?? []).map((m) => [m.id, m.displayName]));

  const apply = (event: FormEvent) => {
    event.preventDefault();
    setFilters({
      action: draft.action.trim() || undefined,
      actorId: draft.actorId || undefined,
      targetId: draft.targetId.trim() || undefined,
      from: startOfDay(draft.from),
      to: endOfDay(draft.to),
    });
  };
  const clear = () => {
    setDraft({ action: '', actorId: '', targetId: '', from: '', to: '' });
    setFilters({});
  };
  const applied = [
    filters.action ? `${t('access.audit.action')}: ${filters.action}` : null,
    filters.actorId
      ? `${t('access.audit.actor')}: ${names.get(filters.actorId) ?? filters.actorId}`
      : null,
    filters.targetId ? `${t('access.audit.target')}: ${filters.targetId}` : null,
    draft.from && filters.from ? `${t('access.audit.from')}: ${draft.from}` : null,
    draft.to && filters.to ? `${t('access.audit.to')}: ${draft.to}` : null,
  ].filter((part): part is string => part !== null);

  const runExport = async (format: 'csv' | 'ndjson') => {
    setExporting(true);
    setExportError(null);
    setExported(false);
    try {
      await withReauth(() => downloadExport(tenantId, format, filters));
      setExported(true);
      // The export is itself an entry in the log: show it.
      await client.invalidateQueries({ queryKey: [tenantId, ...accessKeys.audit] });
      announce(t('access.audit.exported'));
    } catch (error) {
      if (!isCancelled(error)) setExportError(error);
    } finally {
      setExporting(false);
    }
  };

  const actorName = (event: AuditEvent) => {
    if (event.actor.type === 'staff' && event.actor.id) {
      return names.get(event.actor.id) ?? event.actor.id;
    }
    return t(`access.audit.actorTypes.${event.actor.type as 'staff'}`, {
      defaultValue: event.actor.type,
    });
  };
  const targetName = (event: AuditEvent) => {
    if (!event.target) return '—';
    if (event.target.type === 'staff' && event.target.id) {
      return names.get(event.target.id) ?? event.target.id;
    }
    return event.target.id ?? event.target.type;
  };

  const items = log.data?.pages.flatMap((page) => page.items) ?? [];
  const result = verify.data;

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-prose text-sm text-text-secondary">{t('access.audit.intro')}</p>
      <form
        onSubmit={apply}
        aria-labelledby="audit-filters-title"
        className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm"
      >
        <h2 id="audit-filters-title" className="text-md font-semibold text-text">
          {t('access.audit.filters')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <TextField
            id="audit-action"
            label={t('access.audit.action')}
            placeholder={t('access.audit.actionPlaceholder')}
            value={draft.action}
            dir="ltr"
            list="audit-action-list"
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
          />
          <datalist id="audit-action-list">
            {ACTIONS.map((action) => (
              <option key={action} value={action}>
                {auditActionLabel(t, action)}
              </option>
            ))}
          </datalist>
          <SelectField
            id="audit-actor"
            label={t('access.audit.actor')}
            value={draft.actorId}
            onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}
            placeholder={t('access.anyone')}
            options={(members.data?.items ?? []).map((m) => ({
              value: m.id,
              label: m.displayName,
            }))}
          />
          <TextField
            id="audit-target"
            label={t('access.audit.target')}
            placeholder={t('access.audit.targetPlaceholder')}
            value={draft.targetId}
            dir="ltr"
            onChange={(event) => setDraft({ ...draft, targetId: event.target.value })}
          />
          <TextField
            id="audit-from"
            type="date"
            label={t('access.audit.from')}
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
          <TextField
            id="audit-to"
            type="date"
            label={t('access.audit.to')}
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit">{t('access.audit.apply')}</Button>
          <Button type="button" variant="secondary" onClick={clear}>
            {t('access.audit.clear')}
          </Button>
          {applied.length > 0 ? (
            <p className="text-sm text-text-secondary" data-testid="applied-filters">
              <bdi>{t('access.audit.applied', { list: applied.join(' · ') })}</bdi>
            </p>
          ) : null}
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          busy={verify.isFetching}
          onClick={() => void verify.refetch()}
          data-testid="verify-audit"
        >
          <ShieldCheckIcon aria-hidden="true" />
          {t('access.audit.verify')}
        </Button>
        {can('audit.export') ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" busy={exporting} data-testid="export-audit">
                <DownloadIcon aria-hidden="true" />
                {t('access.audit.export')}
                <ChevronDownIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => void runExport('csv')}>
                {t('access.audit.exportCsv')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runExport('ndjson')}>
                {t('access.audit.exportNdjson')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <p className="text-sm text-text-secondary">
          {can('audit.export') ? t('access.audit.exportNote') : t('access.audit.forbiddenExport')}
        </p>
      </div>
      {result ? (
        <p
          role="status"
          data-testid="audit-verification"
          data-ok={result.ok}
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${result.ok ? 'border-success/40 bg-success-subtle' : 'border-danger/30 bg-danger-subtle'}`}
        >
          {result.ok ? (
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          )}
          <span className="text-text">
            {result.ok
              ? t('access.audit.verifyOk', { n: formatNumber(result.checked) })
              : t('access.audit.verifyBroken', { seq: result.seq })}
          </span>
        </p>
      ) : null}
      <ActionError error={verify.error} />
      {exporting ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('access.audit.exporting')}
        </p>
      ) : null}
      {exported ? (
        <p role="status" className="text-sm text-text" data-testid="audit-exported">
          {t('access.audit.exported')}
        </p>
      ) : null}
      <ActionError error={exportError} />

      {log.isPending ? (
        <div role="status" aria-busy="true" aria-label={t('access.audit.loading')}>
          <ListSkeleton rows={4} />
        </div>
      ) : log.isError && items.length === 0 ? (
        <ErrorPanel error={log.error} onRetry={() => log.refetch()} retrying={log.isRefetching} />
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
          {t('access.audit.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
          <Table data-testid="audit-table">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('access.audit.columns.time')}</TableHead>
                <TableHead className="text-start">{t('access.audit.columns.actor')}</TableHead>
                <TableHead className="text-start">{t('access.audit.columns.action')}</TableHead>
                <TableHead className="text-start">{t('access.audit.columns.target')}</TableHead>
                <TableHead className="text-start">{t('access.audit.columns.outcome')}</TableHead>
                <TableHead className="text-start">{t('access.audit.columns.details')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((event) => (
                <TableRow key={event.id} data-action={event.action}>
                  <TableCell>{formatDateTime(event.occurredAt)}</TableCell>
                  <TableCell>
                    <bdi>{actorName(event)}</bdi>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-col">
                      <span className="text-text">{auditActionLabel(t, event.action)}</span>
                      <code dir="ltr" className="text-xs text-text-secondary">
                        {event.action}
                      </code>
                    </span>
                  </TableCell>
                  <TableCell>
                    <bdi dir="auto" className="break-all">
                      {targetName(event)}
                    </bdi>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={OUTCOME_TONE[event.outcome]}>
                      {t(`access.audit.outcomes.${event.outcome}`)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="min-w-56 whitespace-normal">
                    {event.reason ? (
                      <p className="text-sm text-text">
                        <bdi>{t('access.audit.reason', { reason: event.reason })}</bdi>
                      </p>
                    ) : null}
                    {Object.keys(event.data).length > 0 ? (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-link">
                          {t('access.audit.showData')}
                        </summary>
                        <pre
                          dir="ltr"
                          className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface-muted p-2"
                        >
                          {JSON.stringify(event.data, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {log.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          busy={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {t('access.audit.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
