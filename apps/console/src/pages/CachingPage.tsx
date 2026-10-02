import type * as C from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
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
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CircleAlertIcon, CircleCheckIcon, ShieldOffIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/AppDialog';
import { BrandPicker, useChosenBrand } from '../components/BrandPicker';
import { CheckboxField, SelectField, TextField } from '../components/Fields';
import { PageHeader, Section } from '../components/PageHeader';
import { ActionError, Forbidden, QueryState } from '../components/States';
import { api, isApiError } from '../lib/api';
import { formatDateTime, formatDuration, formatNumber } from '../lib/format';
import { useSources, useStudioMutation, useStudioQuery } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { Items } from '../lib/types';

type CachePolicy = C.CachePolicy;
type CacheTier = C.CacheTier;
type CacheInspection = C.CacheInspection;
type CacheEntry = C.CacheEntry;
type CacheImpact = C.CacheImpact;
type CacheInvalidation = C.CacheInvalidation;
type CacheMetrics = C.CacheMetrics;
type ReplyLanguage = C.ReplyLanguage;
type DataClass = CachePolicy['neverCached'][number];

const TIERS: readonly CacheTier[] = [
  'exact_answer',
  'embedding',
  'nlp',
  'retrieval',
  'translation',
];
/** Tiers the product uses today; the others can be set but change nothing yet. */
const IN_USE = new Set<CacheTier>(['exact_answer', 'embedding']);
/** Reply languages named in themselves, as customers choose them in the chat. */
const REPLY_LANGUAGES: Record<ReplyLanguage, string> = {
  en: 'English',
  ar: 'العربية',
  hi: 'हिन्दी',
  ur: 'اردو',
  'hi-Latn': 'Hinglish',
  'ur-Latn': 'Roman Urdu',
};
const REASONS = new Set([
  'personal_data',
  'personalized',
  'tier_disabled',
  'excluded_class',
  'excluded_by_rule',
  'side_effects',
  'incomplete',
  'no_published_agent',
  'dependency_changed',
  'store_unavailable',
  'not_cached',
] as const);
type Reason = typeof REASONS extends Set<infer R> ? R : never;

const keysFor = (brandId: string) => ({
  all: ['cache', brandId] as const,
  policy: ['cache', brandId, 'policy'] as const,
  entries: ['cache', brandId, 'entries'] as const,
  metrics: ['cache', brandId, 'metrics'] as const,
});
const cachePath = (brandId: string) => `/v1/admin/brands/${brandId}/cache`;

function useLocaleFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  return {
    percent: (value: number) =>
      new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value),
    list: (items: string[]) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(items),
  };
}

const languageName = (code: string | null | undefined, any: string) =>
  code ? (REPLY_LANGUAGES[code as ReplyLanguage] ?? code) : any;

/** A fingerprint shortened for tables, full in the title; always left to right. */
function Fingerprint({ value }: { value: string }) {
  return (
    <bdi dir="ltr" className="font-mono text-xs" title={value}>
      {value.slice(0, 12)}
    </bdi>
  );
}

// ---------------------------------------------------------------------------------------------
// Policy (K01, HNV-25-01)

function PolicyForm({ brandId, policy }: { brandId: string; policy: CachePolicy }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const format = useLocaleFormat();
  const [tiers, setTiers] = useState(
    () =>
      Object.fromEntries(
        TIERS.map((tier) => [
          tier,
          {
            enabled: policy.tiers[tier]?.enabled ?? false,
            minutes: String(Math.round((policy.tiers[tier]?.ttlSeconds ?? 3600) / 60)),
          },
        ]),
      ) as Record<CacheTier, { enabled: boolean; minutes: string }>,
  );
  const save = useStudioMutation(
    (body: object, tenant) =>
      api<CachePolicy>(`${cachePath(brandId)}/policy`, { method: 'PUT', tenant, body }),
    [keysFor(brandId).all],
  );
  const manage = can('knowledge.manage');
  const fields = new Map(
    isApiError(save.error) ? save.error.fields.map((f) => [f.path, f.message]) : [],
  );
  return (
    <form
      className="flex flex-col gap-4"
      aria-labelledby="cache-policy-title"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(
          {
            tiers: Object.fromEntries(
              TIERS.map((tier) => [
                tier,
                {
                  enabled: tiers[tier].enabled,
                  ttlSeconds: Math.round(Number(tiers[tier].minutes) * 60),
                },
              ]),
            ),
          },
          { onSuccess: () => announce(t('caching.policy.saved')) },
        );
      }}
    >
      <p className="text-sm text-text-secondary" data-testid="policy-version">
        {t('caching.policy.version', { version: policy.version })}
      </p>
      <fieldset disabled={!manage} className="flex flex-col gap-3">
        <ul className="flex flex-col gap-3" data-testid="cache-tiers">
          {TIERS.map((tier) => (
            <li
              key={tier}
              className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
              data-tier={tier}
            >
              <CheckboxField
                id={`tier-${tier}`}
                label={t('caching.policy.use', { tier: t(`caching.tiers.${tier}`) })}
                hint={t(`caching.tierHints.${tier}`)}
                checked={tiers[tier].enabled}
                disabled={!manage || (!IN_USE.has(tier) && !tiers[tier].enabled)}
                onCheckedChange={(enabled) =>
                  setTiers((current) => ({ ...current, [tier]: { ...current[tier], enabled } }))
                }
              />
              <TextField
                id={`tier-${tier}-ttl`}
                label={t('caching.policy.ttl')}
                hint={t('caching.policy.ttlHint')}
                type="number"
                inputMode="numeric"
                min={1}
                max={43200}
                value={tiers[tier].minutes}
                onChange={(event) =>
                  setTiers((current) => ({
                    ...current,
                    [tier]: { ...current[tier], minutes: event.target.value },
                  }))
                }
                error={fields.get(`tiers.${tier}.ttlSeconds`)}
              />
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-text">
          <ShieldOffIcon className="size-4" aria-hidden="true" />
          {t('caching.policy.neverCached')}
        </p>
        <p className="text-sm text-text-secondary" data-testid="never-cached">
          {format.list(policy.neverCached.map((c: DataClass) => t(`caching.classes.${c}`)))}
        </p>
      </div>
      <ActionError error={save.error} />
      {manage ? (
        <Button type="submit" className="self-start" busy={save.isPending}>
          {t('caching.policy.save')}
        </Button>
      ) : null}
    </form>
  );
}

function PolicySection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const policy = useStudioQuery<CachePolicy>(
    keysFor(brandId).policy,
    `${cachePath(brandId)}/policy`,
  );
  return (
    <Section id="cache-policy" title={t('caching.policy.title')}>
      <QueryState query={policy} label={t('caching.loading')}>
        {(data) => <PolicyForm key={data.version} brandId={brandId} policy={data} />}
      </QueryState>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Inspector (HNV-25-02 to HNV-25-04)

const STATUS_TONE: Record<CacheInspection['status'], StatusTone> = {
  hit: 'success',
  miss: 'info',
  stale: 'warning',
  bypass: 'neutral',
  unavailable: 'danger',
};

function InspectionCard({ result }: { result: CacheInspection }) {
  const { t } = useTranslation();
  const reason =
    result.reason && REASONS.has(result.reason as Reason)
      ? t(`caching.inspect.reasons.${result.reason as Reason}`)
      : result.reason;
  return (
    <section
      aria-labelledby="cache-result-title"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-4 text-sm"
      data-testid="cache-inspection"
      data-status={result.status}
    >
      <h3 id="cache-result-title" className="text-md font-semibold text-text">
        {t('caching.inspect.result')}
      </h3>
      <div className="flex flex-col gap-1">
        <StatusBadge tone={STATUS_TONE[result.status]}>
          {t(`caching.inspect.status.${result.status}`)}
        </StatusBadge>
        {reason ? <p className="text-text-secondary">{reason}</p> : null}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className="text-text-secondary">{t('caching.inspect.language')}</dt>
        <dd>{languageName(result.language, '')}</dd>
        {result.fingerprint ? (
          <>
            <dt className="text-text-secondary">{t('caching.inspect.fingerprint')}</dt>
            <dd>
              <Fingerprint value={result.fingerprint} />
            </dd>
          </>
        ) : null}
        {result.expiresAt ? (
          <>
            <dt className="text-text-secondary">{t('caching.inspect.expires')}</dt>
            <dd>{formatDateTime(result.expiresAt)}</dd>
          </>
        ) : null}
        {result.sources.length > 0 ? (
          <>
            <dt className="text-text-secondary">{t('caching.inspect.sources')}</dt>
            <dd>
              <ul className="flex flex-col gap-1">
                {result.sources.map((source) => (
                  <li key={source.documentId}>
                    <bdi>{source.title}</bdi> ·{' '}
                    {t('caching.inspect.version', { version: source.version })}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
      </dl>
      {result.preview ? (
        <figure className="flex flex-col gap-1">
          <figcaption className="text-text-secondary">{t('caching.inspect.preview')}</figcaption>
          <blockquote
            dir="auto"
            className="whitespace-pre-wrap rounded-md border border-border bg-surface p-3 text-text"
            data-testid="cache-preview"
          >
            {result.preview}
          </blockquote>
        </figure>
      ) : null}
    </section>
  );
}

function InspectSection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [language, setLanguage] = useState('');
  const inspect = useStudioMutation((body: object, tenant) =>
    api<CacheInspection>(`${cachePath(brandId)}/inspect`, { method: 'POST', tenant, body }),
  );
  return (
    <Section
      id="cache-inspect"
      title={t('caching.inspect.title')}
      description={t('caching.inspect.description')}
    >
      <form
        className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end"
        aria-labelledby="cache-inspect-title"
        onSubmit={(event) => {
          event.preventDefault();
          inspect.mutate({ question: question.trim(), ...(language ? { language } : {}) });
        }}
      >
        <TextField
          id="cache-question"
          label={t('caching.inspect.question')}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          required
          maxLength={500}
        />
        <SelectField
          id="cache-language"
          label={t('caching.inspect.language')}
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
          options={[
            { value: '', label: t('caching.inspect.auto') },
            ...Object.entries(REPLY_LANGUAGES).map(([value, label]) => ({ value, label })),
          ]}
        />
        <Button type="submit" busy={inspect.isPending}>
          {t('caching.inspect.run')}
        </Button>
      </form>
      <ActionError error={inspect.error} />
      <div aria-live="polite">{inspect.data ? <InspectionCard result={inspect.data} /> : null}</div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Entries and invalidation (K07, HNV-25-05)

function entryState(entry: CacheEntry): 'active' | 'stale' | 'invalidated' {
  if (entry.invalidatedAt) return 'invalidated';
  return entry.stale ? 'stale' : 'active';
}

const ENTRY_TONE: Record<ReturnType<typeof entryState>, StatusTone> = {
  active: 'success',
  stale: 'warning',
  invalidated: 'neutral',
};

function EntriesSection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const entries = useStudioQuery<Items<CacheEntry>>(
    keysFor(brandId).entries,
    `${cachePath(brandId)}/entries?tier=exact_answer&limit=50`,
  );
  return (
    <Section
      id="cache-entries"
      title={t('caching.entries.title')}
      description={t('caching.entries.description')}
    >
      <QueryState
        query={entries}
        label={t('caching.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('caching.entries.empty')}</p>}
      >
        {(data) => (
          <Table data-testid="cache-entries">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('caching.entries.fingerprint')}</TableHead>
                <TableHead className="text-start">{t('caching.entries.language')}</TableHead>
                <TableHead className="text-start">{t('caching.entries.sources')}</TableHead>
                <TableHead className="text-start">{t('caching.entries.hits')}</TableHead>
                <TableHead className="text-start">{t('caching.entries.stored')}</TableHead>
                <TableHead className="text-start">{t('caching.entries.expires')}</TableHead>
                <TableHead className="text-start">{t('caching.entries.state')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((entry) => {
                const state = entryState(entry);
                return (
                  <TableRow key={entry.fingerprint} data-testid="cache-entry" data-state={state}>
                    <TableCell>
                      <Fingerprint value={entry.fingerprint} />
                    </TableCell>
                    <TableCell>
                      {languageName(entry.language, t('caching.metrics.noLanguage'))}
                    </TableCell>
                    <TableCell>
                      {entry.sources.length === 0
                        ? t('caching.entries.noSources')
                        : entry.sources.map((source) => (
                            <span key={source.documentId} className="block">
                              <bdi>{source.title}</bdi> ·{' '}
                              {t('caching.inspect.version', { version: source.version })}
                            </span>
                          ))}
                    </TableCell>
                    <TableCell>{formatNumber(entry.hits)}</TableCell>
                    <TableCell>{formatDateTime(entry.createdAt)}</TableCell>
                    <TableCell>{formatDateTime(entry.expiresAt)}</TableCell>
                    <TableCell>
                      <StatusBadge tone={ENTRY_TONE[state]}>
                        {t(`caching.entries.states.${state}`)}
                      </StatusBadge>
                      {entry.invalidationReason ? (
                        <span className="block text-xs text-text-secondary">
                          <bdi>
                            {t('caching.entries.reason', {
                              reason: REASONS.has(entry.invalidationReason as Reason)
                                ? t(`caching.inspect.reasons.${entry.invalidationReason as Reason}`)
                                : entry.invalidationReason,
                            })}
                          </bdi>
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </QueryState>
    </Section>
  );
}

function InvalidateSection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const sources = useSources();
  const [sourceId, setSourceId] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<CacheInvalidation | null>(null);
  const impact = useStudioQuery<CacheImpact>(
    [...keysFor(brandId).all, 'impact', sourceId],
    `${cachePath(brandId)}/impact?sourceId=${encodeURIComponent(sourceId)}`,
    { enabled: sourceId !== '' },
  );
  const invalidate = useStudioMutation(
    (body: object, tenant) =>
      api<CacheInvalidation>(`${cachePath(brandId)}/invalidate`, { method: 'POST', tenant, body }),
    [keysFor(brandId).all],
  );
  if (!can('knowledge.manage')) return null;
  const brandSources = (sources.data?.items ?? []).filter((source) => source.brandId === brandId);
  return (
    <Section
      id="cache-invalidate"
      title={t('caching.invalidate.title')}
      description={t('caching.invalidate.description')}
    >
      <form
        className="flex flex-col gap-4"
        aria-labelledby="cache-invalidate-title"
        onSubmit={(event) => {
          event.preventDefault();
          setOutcome(null);
          setConfirming(true);
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField
            id="invalidate-source"
            label={t('caching.invalidate.source')}
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            options={[
              { value: '', label: t('caching.invalidate.allSources') },
              ...brandSources.map((source) => ({ value: source.id, label: source.name })),
            ]}
          />
          <TextField
            id="invalidate-reason"
            label={t('caching.invalidate.reason')}
            hint={t('caching.invalidate.reasonHint')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            maxLength={200}
          />
        </div>
        {sourceId && impact.data ? (
          <p className="text-sm text-text" data-testid="cache-impact">
            {t('caching.invalidate.impact', { count: impact.data.entries })}
          </p>
        ) : null}
        <Button type="submit" variant="destructive" className="self-start">
          {t('caching.invalidate.submit')}
        </Button>
      </form>
      <div aria-live="polite">
        {outcome ? (
          <div className="flex flex-col gap-1 text-sm" data-testid="cache-invalidated">
            <p className="text-text">
              {t('caching.invalidate.done', { count: outcome.invalidated })}
            </p>
            {outcome.failed > 0 ? (
              <p className="text-text-secondary">
                {t('caching.invalidate.failed', { count: outcome.failed })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={setConfirming}
          title={t('caching.invalidate.confirmTitle')}
          confirmLabel={t('caching.invalidate.submit')}
          variant="destructive-solid"
          testId="invalidate-dialog"
          onConfirm={async () => {
            const result = await invalidate.mutateAsync({
              ...(sourceId ? { sourceId } : {}),
              reason: reason.trim(),
            });
            setOutcome(result);
            announce(t('caching.invalidate.done', { count: result.invalidated }));
          }}
        >
          <p>{t('caching.invalidate.confirmBody')}</p>
        </ConfirmDialog>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Metrics and health (K10, HNV-25-06)

function MetricsSection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const format = useLocaleFormat();
  const metrics = useStudioQuery<CacheMetrics>(
    keysFor(brandId).metrics,
    `${cachePath(brandId)}/metrics?days=7`,
    { refetchInterval: 60_000 },
  );
  return (
    <Section
      id="cache-metrics"
      title={t('caching.metrics.title')}
      description={t('caching.metrics.description')}
    >
      <QueryState query={metrics} label={t('caching.loading')}>
        {(data) => (
          <>
            <div
              className="flex flex-col gap-1 text-sm"
              data-testid="cache-health"
              data-health={data.health.store}
            >
              {data.health.store === 'up' ? (
                <p className="flex items-center gap-2 text-text">
                  <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
                  {t('caching.metrics.healthy')}
                </p>
              ) : (
                <div
                  role="status"
                  className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning-subtle p-3"
                >
                  <p className="flex items-center gap-2 font-medium text-text">
                    <CircleAlertIcon className="size-4" aria-hidden="true" />
                    {t('caching.metrics.degraded')}
                  </p>
                  <p className="text-text-secondary">{t('caching.metrics.degradedHint')}</p>
                </div>
              )}
              <p className="text-text-secondary">
                {t('caching.metrics.failures', { count: data.health.recentFailures })}
              </p>
            </div>
            {data.rows.length === 0 ? (
              <p className="text-sm text-text-secondary">{t('caching.metrics.empty')}</p>
            ) : (
              <Table data-testid="cache-metrics">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-start">{t('caching.metrics.day')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.tier')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.language')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.hits')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.misses')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.bypasses')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.stale')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.errors')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.hitRate')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.savedTokens')}</TableHead>
                    <TableHead className="text-start">{t('caching.metrics.savedTime')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row) => {
                    const lookups = row.hits + row.misses;
                    return (
                      <TableRow key={`${row.day}-${row.tier}-${row.language}`}>
                        <TableCell>
                          <bdi dir="ltr">{row.day}</bdi>
                        </TableCell>
                        <TableCell>{t(`caching.tiers.${row.tier}`)}</TableCell>
                        <TableCell>
                          {languageName(row.language, t('caching.metrics.noLanguage'))}
                        </TableCell>
                        <TableCell>{formatNumber(row.hits)}</TableCell>
                        <TableCell>{formatNumber(row.misses)}</TableCell>
                        <TableCell>{formatNumber(row.bypasses)}</TableCell>
                        <TableCell>{formatNumber(row.stale)}</TableCell>
                        <TableCell>{formatNumber(row.errors)}</TableCell>
                        <TableCell>
                          {lookups > 0 ? format.percent(row.hits / lookups) : '—'}
                        </TableCell>
                        <TableCell>
                          {formatNumber(row.savedInputTokens + row.savedOutputTokens)}
                        </TableCell>
                        <TableCell>{formatDuration(row.savedMs)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </QueryState>
    </Section>
  );
}

/**
 * Answer caching (board 25, K01, K02, K07, K08, K10): what is cached, a question inspector,
 * stored answers by fingerprint, stopping reuse after a correction, and use and health.
 */
export function CachingPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/caching' });
  const navigate = useNavigate({ from: '/caching' });
  const { brands, active, chosen } = useChosenBrand(search.brand);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('caching.title')} description={t('caching.description')} />
      {!can('knowledge.read') ? (
        <Forbidden />
      ) : (
        <QueryState
          query={{
            data: brands.items,
            error: brands.error,
            isPending: brands.pending,
            isRefetching: brands.isRefetching,
            refetch: brands.refetch,
          }}
          label={t('caching.loading')}
          permitted={brands.permitted}
        >
          {() =>
            chosen ? (
              <>
                <BrandPicker
                  id="caching-brand"
                  label={t('caching.brand')}
                  brands={active}
                  value={chosen.id}
                  onChange={(brand) => void navigate({ search: { brand } })}
                />
                {!can('knowledge.manage') ? (
                  <p className="text-sm text-text-secondary">{t('caching.noManage')}</p>
                ) : null}
                <div key={chosen.id} className="flex flex-col gap-6">
                  <MetricsSection brandId={chosen.id} />
                  <PolicySection brandId={chosen.id} />
                  <InspectSection brandId={chosen.id} />
                  <EntriesSection brandId={chosen.id} />
                  <InvalidateSection brandId={chosen.id} />
                </div>
              </>
            ) : (
              <p className="text-sm text-text-secondary">{t('caching.noBrands')}</p>
            )
          }
        </QueryState>
      )}
    </div>
  );
}
