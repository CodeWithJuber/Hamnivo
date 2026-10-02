import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@hamnivo/ui/components/sheet';
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
import {
  ChevronRightIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  ShieldAlertIcon,
  WebhookIcon,
  XIcon,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../../components/AppDialog';
import { CheckboxField, SelectField, TextareaField, TextField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { api, isApiError } from '../../lib/api';
import {
  type CreatedWebhookEndpoint,
  endpointPath,
  eventKey,
  isEventCategory,
  type RotatedWebhookSecret,
  sendTest,
  type TestWebhookResult,
  useDeliveries,
  useDelivery,
  useEndpoints,
  useEventTypes,
  useWebhookChange,
  type WebhookAttempt,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEventType,
  type WebhookEventTypeInfo,
} from '../../lib/developer';
import { returnFocus, useOpener } from '../../lib/focus';
import { formatDateTime, formatDuration, formatRelative } from '../../lib/format';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { DeveloperSearch } from '../../routes/_studio/developer';
import { SecretReveal } from './SecretReveal';

const ENDPOINT_TONE: Record<WebhookEndpoint['status'], StatusTone> = {
  active: 'success',
  failing: 'warning',
  disabled: 'neutral',
};

const DELIVERY_TONE: Record<WebhookDelivery['status'], StatusTone> = {
  pending: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const OVERLAP_HOURS = [0, 1, 24, 72] as const;
const REPLAY_WINDOWS = [1, 3, 7] as const;

function useDeveloperSearch() {
  const search = useSearch({ from: '/_studio/developer' });
  const navigate = useNavigate({ from: '/developer' });
  const go = (next: Partial<DeveloperSearch>) =>
    navigate({
      search: (current) => {
        const merged: DeveloperSearch = { ...current, ...next };
        return Object.fromEntries(
          Object.entries(merged).filter(([, value]) => value !== undefined && value !== ''),
        ) as DeveloperSearch;
      },
      replace: true,
    });
  return { search, go };
}

export function EndpointStatus({ endpoint }: { endpoint: WebhookEndpoint }) {
  const { t } = useTranslation();
  return (
    <StatusBadge tone={ENDPOINT_TONE[endpoint.status]} data-testid="endpoint-status">
      {endpoint.status === 'disabled'
        ? t(`developer.webhooks.disabled.${endpoint.disabledReason ?? 'manual'}`)
        : t(`developer.webhooks.status.${endpoint.status}`)}
    </StatusBadge>
  );
}

function DeliveryStatus({ delivery }: { delivery: Pick<WebhookDelivery, 'status'> }) {
  const { t } = useTranslation();
  return (
    <StatusBadge tone={DELIVERY_TONE[delivery.status]}>
      {t(`developer.deliveries.status.${delivery.status}`)}
    </StatusBadge>
  );
}

/** Event types to choose from, grouped by what they are about. */
function EventTypePicker({
  types,
  selected,
  onChange,
  error,
}: {
  types: WebhookEventTypeInfo[];
  selected: WebhookEventType[];
  onChange: (next: WebhookEventType[]) => void;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  const groups = new Map<string, WebhookEventTypeInfo[]>();
  for (const type of types) {
    if (type.type === 'webhook.test') continue;
    groups.set(type.category, [...(groups.get(type.category) ?? []), type]);
  }
  return (
    <fieldset
      className="flex flex-col gap-4"
      aria-describedby={error ? 'event-types-error' : undefined}
    >
      <legend className="mb-1 text-sm font-medium text-text">
        {t('developer.webhooks.form.events')}
      </legend>
      {[...groups].map(([category, items]) => (
        <div key={category} className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-text">
            {isEventCategory(category) ? t(`developer.webhooks.categories.${category}`) : category}
          </p>
          {items.map((item) => (
            <CheckboxField
              key={item.type}
              id={`event-${item.type}`}
              label={
                <bdi dir="ltr" className="font-mono text-xs">
                  {item.type}
                </bdi>
              }
              hint={t(`developer.webhooks.events.${eventKey(item.type)}`)}
              checked={selected.includes(item.type)}
              onCheckedChange={(checked) =>
                onChange(
                  checked ? [...selected, item.type] : selected.filter((s) => s !== item.type),
                )
              }
            />
          ))}
        </div>
      ))}
      {error ? (
        <p id="event-types-error" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function EndpointForm({
  open,
  onOpenChange,
  endpoint,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing this endpoint; adding a new one when absent. */
  endpoint?: WebhookEndpoint;
  onCreated?: (created: CreatedWebhookEndpoint) => void;
}) {
  const { t } = useTranslation();
  const types = useEventTypes();
  const announce = useAnnouncer();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [events, setEvents] = useState<WebhookEventType[]>(endpoint?.eventTypes ?? []);
  const save = useWebhookChange((body: object, tenant) =>
    endpoint
      ? api<WebhookEndpoint>(endpointPath(endpoint.id), { method: 'PATCH', tenant, body })
      : api<CreatedWebhookEndpoint>('/v1/admin/webhooks/endpoints', {
          method: 'POST',
          tenant,
          body,
        }),
  );
  const fields = new Map(
    isApiError(save.error) ? save.error.fields.map((f) => [f.path, f.message]) : [],
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await save.mutateAsync(
        endpoint
          ? {
              url: url.trim(),
              description: description.trim() || null,
              eventTypes: events,
              version: endpoint.version,
            }
          : {
              url: url.trim(),
              ...(description.trim() ? { description: description.trim() } : {}),
              eventTypes: events,
            },
      );
      onOpenChange(false);
      if (endpoint) announce(t('developer.webhooks.form.saved'));
      else onCreated?.(result as CreatedWebhookEndpoint);
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={endpoint ? t('developer.webhooks.form.editTitle') : t('developer.webhooks.form.title')}
      description={t('developer.webhooks.form.description')}
      className="sm:max-w-xl"
      testId="endpoint-form"
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          id="endpoint-url"
          label={t('developer.webhooks.form.url')}
          hint={t('developer.webhooks.form.urlHint')}
          value={url}
          dir="ltr"
          inputMode="url"
          autoComplete="off"
          required
          error={fields.get('url')}
          onChange={(event) => setUrl(event.target.value)}
        />
        <TextareaField
          id="endpoint-description"
          label={t('developer.webhooks.form.note')}
          labelNote={t('app.optional')}
          value={description}
          maxLength={200}
          rows={2}
          onChange={(event) => setDescription(event.target.value)}
        />
        <EventTypePicker
          types={types.data?.items ?? []}
          selected={events}
          onChange={setEvents}
          error={fields.get('eventTypes')}
        />
        <ActionError error={save.error && fields.size === 0 ? save.error : null} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button
            type="submit"
            busy={save.isPending}
            disabled={url.trim() === '' || events.length === 0}
          >
            {endpoint ? t('developer.webhooks.form.save') : t('developer.webhooks.form.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function AttemptList({ attempts }: { attempts: WebhookAttempt[] }) {
  const { t } = useTranslation();
  return (
    <ol className="flex flex-col gap-2" data-testid="attempt-log">
      {attempts.map((attempt) => (
        <li
          key={attempt.attempt}
          className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm"
        >
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">
              {t('developer.deliveries.attemptNumber', { number: attempt.attempt })}
            </span>
            <StatusBadge tone={attempt.outcome === 'succeeded' ? 'success' : 'danger'}>
              {t(`developer.deliveries.outcomes.${attempt.outcome}`)}
            </StatusBadge>
            {attempt.statusCode !== null ? (
              <bdi dir="ltr" className="font-mono text-xs">
                HTTP {attempt.statusCode}
              </bdi>
            ) : null}
          </p>
          <p className="text-text-secondary">
            {formatDateTime(attempt.startedAt)} · {formatDuration(attempt.durationMs)}
          </p>
          {attempt.error ? (
            <p className="text-text-secondary">
              <bdi dir="auto">{attempt.error}</bdi>
            </p>
          ) : null}
          {attempt.responseExcerpt ? (
            <p className="text-text-secondary">
              {t('developer.deliveries.answer')}{' '}
              <bdi dir="ltr" className="font-mono text-xs">
                {attempt.responseExcerpt}
              </bdi>
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function DeliveryDetail({ id, endpoint }: { id: string; endpoint: WebhookEndpoint }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const detail = useDelivery(id);
  const [replaying, setReplaying] = useState(false);
  const replay = useWebhookChange((deliveryId: string, tenant) =>
    api<WebhookDelivery>(`/v1/admin/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`, {
      method: 'POST',
      tenant,
    }),
  );
  return (
    <section
      aria-labelledby="delivery-detail-title"
      className="flex flex-col gap-3 border-t border-border pt-4"
      data-testid="delivery-detail"
    >
      <h3 id="delivery-detail-title" tabIndex={-1} className="text-md font-semibold text-text">
        {t('developer.deliveries.detailTitle')}
      </h3>
      <QueryState query={detail} label={t('developer.deliveries.loadingDetail')}>
        {(delivery) => (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              <dt className="text-text-secondary">{t('developer.deliveries.event')}</dt>
              <dd>
                <bdi dir="ltr" className="font-mono text-xs">
                  {delivery.eventType}
                </bdi>
              </dd>
              <dt className="text-text-secondary">{t('developer.deliveries.eventId')}</dt>
              <dd>
                <bdi dir="ltr" className="break-all font-mono text-xs">
                  {delivery.eventId}
                </bdi>
              </dd>
              <dt className="text-text-secondary">{t('developer.deliveries.statusLabel')}</dt>
              <dd>
                <DeliveryStatus delivery={delivery} />
              </dd>
              <dt className="text-text-secondary">{t('developer.deliveries.attempts')}</dt>
              <dd>
                {t('developer.deliveries.attemptsOf', {
                  count: delivery.attempts,
                  max: delivery.maxAttempts,
                })}
              </dd>
              {delivery.nextAttemptAt ? (
                <>
                  <dt className="text-text-secondary">{t('developer.deliveries.nextAttempt')}</dt>
                  <dd>{formatDateTime(delivery.nextAttemptAt)}</dd>
                </>
              ) : null}
            </dl>
            <AttemptList attempts={delivery.attemptLog} />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-text">{t('developer.deliveries.preview')}</p>
              {delivery.payloadPreview ? (
                <section
                  aria-label={t('developer.deliveries.preview')}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable with the keyboard
                  tabIndex={0}
                  className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-sunken p-3 focus-visible:outline-2"
                >
                  <pre
                    dir="ltr"
                    data-testid="payload-preview"
                    className="text-start font-mono text-xs text-text"
                  >
                    {JSON.stringify(delivery.payloadPreview, null, 2)}
                  </pre>
                </section>
              ) : (
                <p className="text-sm text-text-secondary">{t('developer.deliveries.expired')}</p>
              )}
              <p className="text-xs text-text-secondary">{t('developer.deliveries.previewNote')}</p>
            </div>
            {can('webhooks.manage') && delivery.replayable ? (
              <div>
                <Button
                  variant="secondary"
                  onClick={() => setReplaying(true)}
                  disabled={endpoint.status === 'disabled'}
                  data-testid="replay-delivery"
                >
                  <RotateCcwIcon aria-hidden="true" />
                  {t('developer.deliveries.replay.button')}
                </Button>
                {endpoint.status === 'disabled' ? (
                  <p className="mt-1 text-xs text-text-secondary">
                    {t('developer.deliveries.replay.turnOnFirst')}
                  </p>
                ) : null}
              </div>
            ) : null}
            <ConfirmDialog
              open={replaying}
              onOpenChange={setReplaying}
              title={t('developer.deliveries.replay.title')}
              confirmLabel={t('developer.deliveries.replay.confirm')}
              testId="replay-dialog"
              onConfirm={async () => {
                await replay.mutateAsync(delivery.id);
                announce(t('developer.deliveries.replay.queued'));
              }}
            >
              <p>
                {t('developer.deliveries.replay.description', { event: delivery.eventType })}{' '}
                <bdi dir="ltr" className="break-all font-mono text-xs">
                  {endpoint.url}
                </bdi>
              </p>
              <p className="text-text-secondary">{t('developer.deliveries.replay.dedupe')}</p>
            </ConfirmDialog>
          </div>
        )}
      </QueryState>
    </section>
  );
}

function DeliveryHistory({ endpoint }: { endpoint: WebhookEndpoint }) {
  const { t } = useTranslation();
  const { search, go } = useDeveloperSearch();
  const deliveries = useDeliveries(endpoint.id);
  return (
    <section aria-labelledby="delivery-history-title" className="flex flex-col gap-3">
      <h3 id="delivery-history-title" className="text-md font-semibold text-text">
        {t('developer.deliveries.title')}
      </h3>
      <QueryState
        query={deliveries}
        label={t('developer.deliveries.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('developer.deliveries.empty')}</p>}
      >
        {(data) => (
          <ul className="flex flex-col gap-2" data-testid="delivery-history">
            {data.items.map((delivery) => {
              const selected = search.delivery === delivery.id;
              return (
                <li key={delivery.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => void go({ delivery: selected ? undefined : delivery.id })}
                    className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-start text-sm hover:bg-surface-sunken aria-pressed:border-text"
                    data-testid="delivery-row"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <bdi dir="ltr" className="font-mono text-xs text-text">
                        {delivery.eventType}
                      </bdi>
                      <span className="text-text-secondary">
                        {formatRelative(delivery.lastAttemptAt ?? delivery.createdAt)} ·{' '}
                        {t('developer.deliveries.attemptsOf', {
                          count: delivery.attempts,
                          max: delivery.maxAttempts,
                        })}
                        {delivery.replayOf ? ` · ${t('developer.deliveries.replayed')}` : ''}
                      </span>
                    </span>
                    {delivery.lastStatusCode !== null ? (
                      <bdi dir="ltr" className="font-mono text-xs text-text-secondary">
                        {delivery.lastStatusCode}
                      </bdi>
                    ) : null}
                    <DeliveryStatus delivery={delivery} />
                    <ChevronRightIcon
                      className="size-4 shrink-0 rtl:rotate-180"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
      {search.delivery ? <DeliveryDetail id={search.delivery} endpoint={endpoint} /> : null}
    </section>
  );
}

function EndpointActions({
  endpoint,
  onSecret,
}: {
  endpoint: WebhookEndpoint;
  onSecret: (secret: string) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { go } = useDeveloperSearch();
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [overlap, setOverlap] = useState('24');
  const [replayDays, setReplayDays] = useState('1');
  const [result, setResult] = useState<TestWebhookResult | null>(null);
  const test = useWebhookChange((id: string, tenant) => sendTest(id, tenant));
  const rotate = useWebhookChange((hours: number, tenant) =>
    api<RotatedWebhookSecret>(`${endpointPath(endpoint.id)}/rotate-secret`, {
      method: 'POST',
      tenant,
      body: { overlapHours: hours },
    }),
  );
  const toggle = useWebhookChange((status: 'active' | 'disabled', tenant) =>
    api<WebhookEndpoint>(endpointPath(endpoint.id), {
      method: 'PATCH',
      tenant,
      body: { status, version: endpoint.version },
    }),
  );
  const remove = useWebhookChange((_: undefined, tenant) =>
    api<void>(endpointPath(endpoint.id), { method: 'DELETE', tenant }),
  );
  const replayFailed = useWebhookChange((days: number, tenant) =>
    api<{ replayed: number; expired: number }>(`${endpointPath(endpoint.id)}/replay-failed`, {
      method: 'POST',
      tenant,
      body: { since: new Date(Date.now() - days * 86_400_000).toISOString() },
    }),
  );
  const off = endpoint.status === 'disabled';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          busy={test.isPending}
          data-testid="send-test"
          onClick={async () => {
            setResult(null);
            try {
              const sent = await test.mutateAsync(endpoint.id);
              setResult(sent);
              announce(
                sent.verified
                  ? t('developer.webhooks.test.verified')
                  : t('developer.webhooks.test.failed'),
              );
            } catch (caught) {
              if (isCancelled(caught)) return;
            }
          }}
        >
          <SendIcon aria-hidden="true" />
          {t('developer.webhooks.test.button')}
        </Button>
        <Button variant="secondary" onClick={() => setRotating(true)} data-testid="rotate-secret">
          {t('developer.webhooks.rotate.button')}
        </Button>
        <Button variant="secondary" onClick={() => setEditing(true)}>
          {t('developer.webhooks.edit')}
        </Button>
        <Button variant="secondary" onClick={() => setToggling(true)} data-testid="toggle-endpoint">
          {off ? t('developer.webhooks.turnOn.button') : t('developer.webhooks.turnOff.button')}
        </Button>
        <Button variant="secondary" onClick={() => setReplaying(true)} disabled={off}>
          {t('developer.webhooks.replayFailed.button')}
        </Button>
        <Button variant="destructive" onClick={() => setDeleting(true)}>
          {t('developer.webhooks.delete.button')}
        </Button>
      </div>
      <ActionError error={test.error} />
      {result ? (
        <p
          role="status"
          data-testid="test-result"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm"
        >
          <StatusBadge tone={result.verified ? 'success' : 'danger'}>
            {result.verified
              ? t('developer.webhooks.test.verifiedBadge')
              : t(`developer.deliveries.outcomes.${result.attempt.outcome}`)}
          </StatusBadge>
          <span>
            {result.verified
              ? t('developer.webhooks.test.verified')
              : t('developer.webhooks.test.failed')}
          </span>
          {result.attempt.statusCode !== null ? (
            <bdi dir="ltr" className="font-mono text-xs">
              HTTP {result.attempt.statusCode}
            </bdi>
          ) : null}
          {result.attempt.error ? (
            <span className="text-text-secondary">
              <bdi dir="auto">{result.attempt.error}</bdi>
            </span>
          ) : null}
        </p>
      ) : null}
      {editing ? (
        <EndpointForm open={editing} onOpenChange={setEditing} endpoint={endpoint} />
      ) : null}
      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        title={t('developer.webhooks.rotate.title')}
        confirmLabel={t('developer.webhooks.rotate.confirm')}
        testId="rotate-secret-dialog"
        failureNote={t('developer.webhooks.rotate.unchanged')}
        onConfirm={async () => {
          const rotated = await rotate.mutateAsync(Number(overlap));
          onSecret(rotated.signingSecret);
        }}
      >
        <p>{t('developer.webhooks.rotate.description')}</p>
        <SelectField
          id="rotate-secret-overlap"
          label={t('developer.webhooks.rotate.overlap')}
          value={overlap}
          onChange={(event) => setOverlap(event.target.value)}
          options={OVERLAP_HOURS.map((hours) => ({
            value: String(hours),
            label: t(`developer.webhooks.rotate.overlaps.${hours}`),
          }))}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={toggling}
        onOpenChange={setToggling}
        title={off ? t('developer.webhooks.turnOn.title') : t('developer.webhooks.turnOff.title')}
        confirmLabel={
          off ? t('developer.webhooks.turnOn.confirm') : t('developer.webhooks.turnOff.confirm')
        }
        testId="toggle-endpoint-dialog"
        onConfirm={async () => {
          await toggle.mutateAsync(off ? 'active' : 'disabled');
          announce(
            off ? t('developer.webhooks.turnOn.done') : t('developer.webhooks.turnOff.done'),
          );
        }}
      >
        <p>
          {off
            ? t('developer.webhooks.turnOn.description')
            : t('developer.webhooks.turnOff.description')}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={replaying}
        onOpenChange={setReplaying}
        title={t('developer.webhooks.replayFailed.title')}
        confirmLabel={t('developer.webhooks.replayFailed.confirm')}
        testId="replay-failed-dialog"
        onConfirm={async () => {
          const done = await replayFailed.mutateAsync(Number(replayDays));
          announce(
            t('developer.webhooks.replayFailed.done', {
              count: done.replayed,
              expired: done.expired,
            }),
          );
        }}
      >
        <p>{t('developer.webhooks.replayFailed.description')}</p>
        <SelectField
          id="replay-window"
          label={t('developer.webhooks.replayFailed.since')}
          value={replayDays}
          onChange={(event) => setReplayDays(event.target.value)}
          options={REPLAY_WINDOWS.map((days) => ({
            value: String(days),
            label: t(`developer.webhooks.replayFailed.windows.${days}`),
          }))}
        />
        <p className="text-text-secondary">{t('developer.deliveries.replay.dedupe')}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('developer.webhooks.delete.title')}
        confirmLabel={t('developer.webhooks.delete.confirm')}
        variant="destructive"
        testId="delete-endpoint-dialog"
        onConfirm={async () => {
          await remove.mutateAsync(undefined);
          announce(t('developer.webhooks.delete.done'));
          await go({ endpoint: undefined, delivery: undefined });
        }}
      >
        <p>{t('developer.webhooks.delete.description')}</p>
        <p>
          <bdi dir="ltr" className="break-all font-mono text-xs">
            {endpoint.url}
          </bdi>
        </p>
      </ConfirmDialog>
    </div>
  );
}

function EndpointDrawer({ endpoint }: { endpoint: WebhookEndpoint | undefined }) {
  const { t, i18n } = useTranslation();
  const { can } = useTenant();
  const { go } = useDeveloperSearch();
  const opener = useOpener(endpoint !== undefined);
  const [secret, setSecret] = useState<string | null>(null);
  const rtl = i18n.dir() === 'rtl';
  return (
    <>
      <Sheet
        open={endpoint !== undefined}
        onOpenChange={(open) => {
          if (!open) void go({ endpoint: undefined, delivery: undefined });
        }}
      >
        <SheetContent
          side={rtl ? 'left' : 'right'}
          showCloseButton={false}
          className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl"
          data-testid="endpoint-drawer"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus(opener.current);
          }}
        >
          {endpoint ? (
            <>
              <div className="flex items-start justify-between gap-3 border-b border-border p-4">
                <div className="flex min-w-0 flex-col gap-2">
                  <SheetTitle className="text-lg">
                    <bdi dir="ltr" className="break-all">
                      {endpoint.url}
                    </bdi>
                  </SheetTitle>
                  <SheetDescription className="flex flex-wrap items-center gap-2 text-sm">
                    <EndpointStatus endpoint={endpoint} />
                    {endpoint.verifiedAt ? (
                      <span>
                        {t('developer.webhooks.verifiedAt', {
                          time: formatDateTime(endpoint.verifiedAt),
                        })}
                      </span>
                    ) : (
                      <span>{t('developer.webhooks.notVerified')}</span>
                    )}
                  </SheetDescription>
                </div>
                <SheetClose asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={t('app.close')}>
                    <XIcon aria-hidden="true" />
                  </Button>
                </SheetClose>
              </div>
              <div className="flex flex-col gap-5 p-4">
                {endpoint.blockedByAllowlist ? (
                  <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-text">
                    <ShieldAlertIcon
                      className="mt-0.5 size-4 shrink-0 text-warning"
                      aria-hidden="true"
                    />
                    {t('developer.webhooks.blocked')}
                  </p>
                ) : null}
                {endpoint.status === 'failing' ? (
                  <p className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-text">
                    {t('developer.webhooks.failingNote', {
                      count: endpoint.health.consecutiveFailures,
                    })}
                  </p>
                ) : null}
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                  {endpoint.description ? (
                    <>
                      <dt className="text-text-secondary">{t('developer.webhooks.form.note')}</dt>
                      <dd>
                        <bdi dir="auto">{endpoint.description}</bdi>
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-text-secondary">{t('developer.webhooks.columns.events')}</dt>
                  <dd className="flex flex-wrap gap-1">
                    {endpoint.eventTypes.map((type) => (
                      <bdi
                        key={type}
                        dir="ltr"
                        className="rounded border border-border px-1.5 py-0.5 font-mono text-xs"
                      >
                        {type}
                      </bdi>
                    ))}
                  </dd>
                  <dt className="text-text-secondary">{t('developer.webhooks.secret')}</dt>
                  <dd className="flex flex-col gap-1">
                    <bdi dir="ltr" className="font-mono text-xs" data-testid="secret-hint">
                      whsec_••••{endpoint.secret.hint}
                    </bdi>
                    {endpoint.secret.previousValidUntil ? (
                      <span className="text-text-secondary">
                        {t('developer.webhooks.previousValid', {
                          time: formatDateTime(endpoint.secret.previousValidUntil),
                        })}
                      </span>
                    ) : null}
                  </dd>
                </dl>
                {can('webhooks.manage') ? (
                  <EndpointActions endpoint={endpoint} onSecret={setSecret} />
                ) : null}
                <DeliveryHistory endpoint={endpoint} />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
      <SecretReveal
        secret={secret}
        title={t('developer.webhooks.rotate.revealTitle')}
        label={t('developer.webhooks.secretLabel')}
        onDone={() => setSecret(null)}
        testId="secret-reveal"
      />
    </>
  );
}

/** Webhook endpoints (D06): list, add, test, inspect deliveries and replay. */
export function WebhooksTab() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const { search, go } = useDeveloperSearch();
  const endpoints = useEndpoints();
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<CreatedWebhookEndpoint | null>(null);
  const selected = endpoints.data?.items.find((endpoint) => endpoint.id === search.endpoint);
  return (
    <Section
      id="webhooks"
      title={t('developer.webhooks.title')}
      description={t('developer.webhooks.description')}
      actions={
        can('webhooks.manage') ? (
          <Button onClick={() => setAdding(true)} data-testid="add-endpoint">
            <PlusIcon aria-hidden="true" />
            {t('developer.webhooks.add')}
          </Button>
        ) : null
      }
    >
      <QueryState
        query={endpoints}
        label={t('developer.webhooks.loading')}
        permitted={can('webhooks.read')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
            <WebhookIcon className="size-6 text-text-muted" aria-hidden="true" />
            <p className="text-sm text-text-secondary">{t('developer.webhooks.empty')}</p>
          </div>
        }
      >
        {(data) => (
          <div className="overflow-x-auto">
            <Table data-testid="endpoints">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('developer.webhooks.columns.url')}</TableHead>
                  <TableHead>{t('developer.webhooks.columns.status')}</TableHead>
                  <TableHead>{t('developer.webhooks.columns.events')}</TableHead>
                  <TableHead>{t('developer.webhooks.columns.latest')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('developer.webhooks.columns.open')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((endpoint) => (
                  <TableRow key={endpoint.id} data-testid="endpoint-row">
                    <TableCell className="max-w-[18rem]">
                      <bdi
                        dir="ltr"
                        className="block truncate font-mono text-xs"
                        title={endpoint.url}
                      >
                        {endpoint.url}
                      </bdi>
                    </TableCell>
                    <TableCell>
                      <EndpointStatus endpoint={endpoint} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {t('developer.webhooks.eventCount', { count: endpoint.eventTypes.length })}
                    </TableCell>
                    <TableCell>
                      {endpoint.latestDelivery ? (
                        <span className="flex items-center gap-2">
                          <DeliveryStatus delivery={endpoint.latestDelivery} />
                          <span className="text-text-secondary">
                            {formatRelative(endpoint.latestDelivery.at)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-text-secondary">
                          {t('developer.webhooks.noDeliveries')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void go({ endpoint: endpoint.id, delivery: undefined })}
                        aria-label={t('developer.webhooks.openLabel', { url: endpoint.url })}
                        data-testid="open-endpoint"
                      >
                        {t('developer.webhooks.open')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
      {adding ? (
        <EndpointForm open={adding} onOpenChange={setAdding} onCreated={setCreated} />
      ) : null}
      <EndpointDrawer endpoint={selected} />
      <SecretReveal
        secret={created?.signingSecret ?? null}
        title={t('developer.webhooks.created')}
        label={t('developer.webhooks.secretLabel')}
        onDone={() => {
          const id = created?.id;
          setCreated(null);
          if (id) void go({ endpoint: id });
        }}
        testId="endpoint-secret-reveal"
      />
    </Section>
  );
}
