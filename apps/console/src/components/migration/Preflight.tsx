import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../lib/format';
import type { MigrationPreflight, MigrationSourceInfo } from '../../lib/migration';
import { CheckBadge, Notice } from './MigrationParts';

type Check = MigrationPreflight['checks'][number];

const CHECK_CODES = [
  'authority_connected',
  'import_inbox',
  'authority_admin',
  'automations',
  'integrations',
  'authority_unreachable',
  'source_mismatch',
] as const;
type CheckCode = (typeof CHECK_CODES)[number];

const SETTINGS = [
  'webhook',
  'agent_bot',
  'auto_assignment',
  'greeting',
  'csat',
  'working_hours',
  'single_conversation',
] as const;

const LIMITS = [
  'tawk_export_cap',
  'tawk_rest_approval',
  'tawk_attachment_links',
  'tawk_tickets',
  'tawk_no_notes',
  'tawk_unverified_email',
  'package_links_only',
] as const;

/** A readiness check in plain words (M01): what is ready, or what to change in Chatwoot. */
export function checkText(t: TFunction, check: Check): string {
  const code = check.code as CheckCode;
  if (!(CHECK_CODES as readonly string[]).includes(code)) return check.code;
  if (code === 'import_inbox' && check.status === 'ok' && check.detail === 'will_create') {
    return t('migration.preflight.checks.codes.import_inbox.will_create');
  }
  if (check.status === 'ok') return t(`migration.preflight.checks.codes.${code}.ok`);
  let detail = check.detail ?? '';
  if (code === 'import_inbox') {
    detail = detail
      .split(',')
      .map((s) =>
        (SETTINGS as readonly string[]).includes(s)
          ? t(`migration.preflight.checks.settings.${s as (typeof SETTINGS)[number]}`)
          : s,
      )
      .join(', ');
  }
  if (code === 'source_mismatch' && detail) {
    return t('migration.preflight.detected', {
      source: t(`migration.sources.${detail as 'tawk.to'}`, { defaultValue: detail }),
    });
  }
  return t(`migration.preflight.checks.codes.${code}.blocked`, { detail });
}

/** A reason or issue code in plain words; unknown codes are shown as they are. */
export function reasonText(t: TFunction, code: string | null | undefined): string {
  if (!code) return '';
  return t(`migration.reasons.${code as 'invalid_record'}`, { defaultValue: code });
}

function targetText(t: TFunction, target: string | null): string {
  if (!target) return t('migration.preflight.fields.none');
  if (target.startsWith('package.')) return t('migration.preflight.fields.same');
  return t(`migration.preflight.fields.targets.${target as 'message.text'}`, {
    defaultValue: target,
  });
}

/** Paths are compared without array markers: `messages[].time` and `messages.time` are the same. */
const bare = (path: string) => path.replaceAll('[]', '');

/** What the export holds, the destination checks, the fields and the known limits (M01). */
export function PreflightReport({
  preflight,
  source,
}: {
  preflight: MigrationPreflight;
  source: MigrationSourceInfo | undefined;
}) {
  const { t } = useTranslation();
  const required = new Set(
    (source?.fields ?? []).filter((f) => f.required).map((f) => bare(f.source)),
  );
  const counts = [
    ['conversations', preflight.counts.conversations],
    ['messages', preflight.counts.messages],
    ['internalNotes', preflight.counts.internalNotes],
    ['contacts', preflight.counts.contacts],
    ['attachments', preflight.counts.attachments],
    ['attachmentFiles', preflight.counts.attachmentFiles],
  ] as const;
  const sourceName = t(`migration.sources.${preflight.source.system}`);

  return (
    <div className="flex flex-col gap-6" data-testid="preflight">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-md font-semibold text-text">{t('migration.preflight.title')}</h3>
          <p className="text-sm text-text-secondary">{t('migration.preflight.description')}</p>
        </div>
        <dl
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6"
          data-testid="preflight-counts"
        >
          {counts.map(([key, value]) => (
            <div key={key} className="flex flex-col gap-0.5" data-count={key}>
              <dt className="text-xs text-text-secondary">
                {t(`migration.preflight.counts.${key}`)}
              </dt>
              <dd className="text-xl font-semibold tabular-nums text-text">
                {formatNumber(value)}
              </dd>
            </div>
          ))}
        </dl>
        {preflight.truncated ? (
          <Notice
            tone="warning"
            title={t('migration.preflight.truncated')}
            testId="preflight-truncated"
          >
            <p>{t('migration.preflight.truncatedHint')}</p>
            {preflight.declared?.conversations !== undefined ||
            preflight.declared?.messages !== undefined ? (
              <p>
                {t('migration.preflight.declared', {
                  conversations: formatNumber(preflight.declared?.conversations ?? null),
                  messages: formatNumber(preflight.declared?.messages ?? null),
                })}
              </p>
            ) : null}
          </Notice>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-md font-semibold text-text">{t('migration.preflight.checks.title')}</h3>
        <ul className="flex flex-col gap-2" data-testid="preflight-checks">
          {preflight.checks.map((check) => (
            <li
              key={check.code}
              data-code={check.code}
              data-status={check.status}
              className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border p-3"
            >
              <span className="min-w-0 flex-1 text-sm text-text">{checkText(t, check)}</span>
              <CheckBadge status={check.status} />
            </li>
          ))}
        </ul>
      </div>

      {preflight.missingRequired.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="missing-required">
          {preflight.missingRequired.map((field) => (
            <Notice key={field} tone="danger" title={t('migration.preflight.missing.title')}>
              <p>{t('migration.preflight.missing.description', { field })}</p>
            </Notice>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-md font-semibold text-text">
            {t('migration.preflight.fields.title')}
          </h3>
          <p className="text-sm text-text-secondary">
            {t('migration.preflight.fields.description')}
          </p>
        </div>
        <Table data-testid="preflight-fields">
          <TableHeader>
            <TableRow>
              <TableHead className="text-start">
                {t('migration.preflight.fields.columns.source')}
              </TableHead>
              <TableHead className="text-start">
                {t('migration.preflight.fields.columns.target')}
              </TableHead>
              <TableHead className="text-start">
                {t('migration.preflight.fields.columns.status')}
              </TableHead>
              <TableHead className="text-start">
                {t('migration.preflight.fields.columns.found')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preflight.fields.map((field) => (
              <TableRow key={field.path} data-field={field.path} data-field-status={field.status}>
                <TableCell>
                  <bdi dir="ltr" className="font-mono text-xs">
                    {field.path}
                  </bdi>
                </TableCell>
                <TableCell className="whitespace-normal">{targetText(t, field.target)}</TableCell>
                <TableCell>
                  <span className="inline-flex flex-wrap gap-1">
                    <StatusBadge
                      tone={
                        field.status === 'supported'
                          ? 'success'
                          : field.status === 'transformed'
                            ? 'info'
                            : 'warning'
                      }
                    >
                      {t(`migration.preflight.fields.status.${field.status}`)}
                    </StatusBadge>
                    {required.has(bare(field.path)) ? (
                      <StatusBadge tone="brand">
                        {t('migration.preflight.fields.required')}
                      </StatusBadge>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  {t('migration.preflight.fields.records', { count: field.count })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {preflight.limits.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-md font-semibold text-text">
            {t('migration.preflight.limits.title', { source: sourceName })}
          </h3>
          <ul className="flex flex-col gap-2" data-testid="preflight-limits">
            {preflight.limits.map((limit) => (
              <li key={limit.code} data-limit={limit.code}>
                <Notice tone={limit.severity === 'warning' ? 'warning' : 'info'}>
                  <p>
                    {(LIMITS as readonly string[]).includes(limit.code)
                      ? t(
                          `migration.preflight.limits.codes.${limit.code as (typeof LIMITS)[number]}`,
                        )
                      : limit.code}
                  </p>
                </Notice>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="text-md font-semibold text-text">{t('migration.preflight.issues.title')}</h3>
        {preflight.issues.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('migration.preflight.issues.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="preflight-issues">
            {preflight.issues.map((issue) => (
              <li
                key={`${issue.severity}:${issue.code}`}
                data-issue={issue.code}
                className="flex flex-col gap-1 rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text">{reasonText(t, issue.code)}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary">
                      {t('migration.preflight.issues.count', { count: issue.count })}
                    </span>
                    <StatusBadge tone={issue.severity === 'error' ? 'danger' : 'warning'}>
                      {t(`migration.preflight.issues.${issue.severity}`)}
                    </StatusBadge>
                  </span>
                </div>
                {issue.examples.some((e) => e.sourceId || e.location) ? (
                  <p className="text-xs text-text-secondary">
                    {t('migration.preflight.issues.examples', { ids: '' })}
                    <bdi dir="ltr" className="font-mono">
                      {issue.examples
                        .map((e) => e.sourceId ?? e.location)
                        .filter(Boolean)
                        .join(', ')}
                    </bdi>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
