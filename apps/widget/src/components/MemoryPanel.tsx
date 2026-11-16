import type { MemoryDeletionReceipt, MemoryItem } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { Switch } from '@hamnivo/ui/components/switch';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSlotLabel } from '../memory-slots.js';
import type { MemoryControls } from '../useMemory.js';

function useDate() {
  const { i18n } = useTranslation();
  return (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso))
      : '';
}

function Receipt({ receipt }: { receipt: MemoryDeletionReceipt }) {
  const { t } = useTranslation();
  const done = receipt.status === 'completed';
  return (
    <p
      role="status"
      data-testid="memory-receipt"
      data-status={receipt.status}
      className="rounded-xl border border-success/30 bg-success-subtle px-3 py-2 text-sm text-text"
    >
      {t(receipt.scope === 'customer' ? 'memory.receipt.forgot' : 'memory.receipt.deleted')}{' '}
      {t(done ? 'memory.receipt.done' : 'memory.receipt.pending')}
    </p>
  );
}

function Item({
  item,
  current,
  controls,
}: {
  item: MemoryItem;
  current: MemoryItem | undefined;
  controls: MemoryControls;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const label = useSlotLabel();
  const date = useDate();
  const id = useId();
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const [value, setValue] = useState(item.value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = item.status === 'pending';

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      announce(done);
      setMode('view');
    } catch (caught) {
      const detail = (caught as { problem?: { detail?: unknown } })?.problem?.detail;
      setError(typeof detail === 'string' ? detail : t('memory.error'));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = value.trim();
    if (!next) {
      setError(t('memory.item.valueRequired'));
      return;
    }
    void run(() => controls.correct(item.id, next), t('memory.item.saved'));
  };

  return (
    <li
      data-memory={item.key}
      data-status={item.status}
      className={`flex flex-col gap-2 rounded-xl border p-3 text-sm ${
        pending ? 'border-warning/40 bg-warning-subtle' : 'border-border bg-surface'
      }`}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-text-secondary">{label(item.key)}</span>
        <bdi dir="auto" className="text-[0.9375rem] font-medium text-text">
          {item.value}
        </bdi>
      </div>
      {pending ? (
        <p className="text-text">
          {current
            ? t('memory.item.reviewWithCurrent', { current: current.value })
            : t('memory.item.review')}
        </p>
      ) : null}
      <p className="text-xs text-text-secondary">
        {t(
          `memory.item.source.${item.source.type === 'customer_statement' ? 'message' : item.source.type === 'staff_entry' ? 'staff' : 'you'}`,
          {
            date: date(item.source.observedAt),
          },
        )}
        {item.expiresAt ? ` · ${t('memory.item.keptUntil', { date: date(item.expiresAt) })}` : ''}
      </p>
      {item.evidenceStatus === 'unknown' ? (
        <p className="text-xs text-text-secondary">{t('memory.item.notChecked')}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
      {mode === 'edit' ? (
        <form className="flex flex-col gap-2" onSubmit={save} noValidate>
          <label htmlFor={`${id}-value`} className="text-xs font-medium text-text">
            {t('memory.item.newValue', { label: label(item.key) })}
          </label>
          <input
            id={`${id}-value`}
            dir="auto"
            maxLength={200}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="min-h-11 rounded-xl border border-input bg-bg px-3 text-base text-text"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-11" busy={busy}>
              {t('memory.item.save')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={busy}
              onClick={() => {
                setMode('view');
                setValue(item.value);
                setError(null);
              }}
            >
              {t('memory.item.cancel')}
            </Button>
          </div>
        </form>
      ) : mode === 'delete' ? (
        <div className="flex flex-col gap-2">
          <p className="text-text">{t('memory.item.deleteConfirm')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive-solid"
              className="min-h-11"
              busy={busy}
              onClick={() => void run(() => controls.remove(item.id), t('memory.receipt.deleted'))}
            >
              {t('memory.item.deleteYes')}
            </Button>
            <Button
              variant="secondary"
              className="min-h-11"
              disabled={busy}
              onClick={() => setMode('view')}
            >
              {t('memory.item.cancel')}
            </Button>
          </div>
        </div>
      ) : pending ? (
        <div className="flex flex-wrap gap-2">
          <Button
            className="min-h-11"
            busy={busy}
            onClick={() => void run(() => controls.confirm(item.id), t('memory.item.confirmed'))}
          >
            {t('memory.item.confirm')}
          </Button>
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={busy}
            onClick={() => void run(() => controls.remove(item.id), t('memory.item.keptOld'))}
          >
            {t('memory.item.keepOld')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="min-h-11"
            aria-label={t('memory.item.correctLabel', { label: label(item.key) })}
            onClick={() => {
              setValue(item.value);
              setMode('edit');
            }}
          >
            {t('memory.item.correct')}
          </Button>
          <Button
            variant="destructive"
            className="min-h-11"
            aria-label={t('memory.item.deleteLabel', { label: label(item.key) })}
            onClick={() => setMode('delete')}
          >
            {t('memory.item.delete')}
          </Button>
        </div>
      )}
    </li>
  );
}

/** "What we remember" (L04, HNV-15-02 to 15-06): see, correct, confirm, delete, turn off. */
export function MemoryPanel({
  controls,
  onBack,
}: {
  controls: MemoryControls;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { state } = controls;
  const memory = state.memory;
  const [switching, setSwitching] = useState(false);
  const [forgetting, setForgetting] = useState<'ask' | 'busy' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const on = memory?.consent.state === 'granted';

  useEffect(() => {
    document.getElementById('memory-title')?.focus();
  }, []);

  const toggle = async (next: boolean) => {
    setSwitching(true);
    setError(null);
    try {
      await controls.setConsent(next ? 'granted' : 'withdrawn');
      announce(t(next ? 'memory.switch.turnedOn' : 'memory.switch.turnedOff'));
    } catch {
      setError(t('memory.error'));
    } finally {
      setSwitching(false);
    }
  };

  const forget = async () => {
    setForgetting('busy');
    setError(null);
    try {
      await controls.forget();
      announce(t('memory.receipt.forgot'));
      setForgetting(null);
    } catch {
      setError(t('memory.error'));
      setForgetting('ask');
    }
  };

  const items = memory?.items ?? [];
  const active = items.filter((item) => item.status === 'active');
  const pending = items.filter((item) => item.status === 'pending');

  return (
    <section
      aria-labelledby="memory-title"
      data-testid="memory-panel"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
    >
      <div className="flex flex-col gap-1">
        <Button variant="link" className="h-auto self-start text-sm" onClick={onBack}>
          <span aria-hidden="true" className="rtl:-scale-x-100">
            ←
          </span>
          {t('memory.back')}
        </Button>
        <h2 id="memory-title" tabIndex={-1} className="text-lg font-semibold text-text">
          {t('memory.title')}
        </h2>
        <p className="text-sm text-text-secondary">{t('memory.intro')}</p>
      </div>

      {state.phase === 'loading' ? (
        <p role="status" className="text-sm text-text-muted">
          {t('memory.loading')}
        </p>
      ) : state.phase === 'error' || !memory ? (
        <div role="alert" data-testid="memory-unavailable" className="flex flex-col gap-2 text-sm">
          <p className="text-text">{t('memory.unavailable')}</p>
          <Button
            variant="secondary"
            className="min-h-11 self-start"
            onClick={() => void controls.reload()}
          >
            {t('retry')}
          </Button>
        </div>
      ) : (
        <>
          {memory.offered || on ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface p-3">
              <div className="flex flex-col gap-0.5">
                <label htmlFor="memory-switch" className="text-sm font-medium text-text">
                  {t('memory.switch.label')}
                </label>
                <p id="memory-switch-hint" className="text-xs text-text-secondary">
                  {t(on ? 'memory.switch.onHint' : 'memory.switch.offHint')}
                </p>
              </div>
              <Switch
                id="memory-switch"
                checked={on}
                disabled={switching}
                aria-describedby="memory-switch-hint"
                onCheckedChange={(next) => void toggle(next)}
              />
            </div>
          ) : (
            <p className="text-sm text-text-secondary" data-testid="memory-not-offered">
              {t('memory.notOffered')}
            </p>
          )}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {state.deletions.map((receipt) => (
            <Receipt key={receipt.id} receipt={receipt} />
          ))}
          {pending.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-text">{t('memory.reviewTitle')}</h3>
              <ul className="flex flex-col gap-2">
                {pending.map((item) => (
                  <Item
                    key={item.id}
                    item={item}
                    current={active.find((other) => other.id === item.conflictsWith)}
                    controls={controls}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          {active.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label={t('memory.title')}>
              {active.map((item) => (
                <Item key={item.id} item={item} current={undefined} controls={controls} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-text-secondary" data-testid="memory-empty">
              {t('memory.empty')}
            </p>
          )}
          <p className="text-xs text-text-secondary">{t('memory.never')}</p>
          {items.length > 0 ? (
            forgetting ? (
              <div className="flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger-subtle p-3 text-sm">
                <p className="text-text">{t('memory.forget.confirm')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive-solid"
                    className="min-h-11"
                    busy={forgetting === 'busy'}
                    onClick={() => void forget()}
                  >
                    {t('memory.forget.yes')}
                  </Button>
                  <Button
                    variant="secondary"
                    className="min-h-11"
                    disabled={forgetting === 'busy'}
                    onClick={() => setForgetting(null)}
                  >
                    {t('memory.item.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="destructive"
                className="min-h-11 self-start"
                onClick={() => setForgetting('ask')}
              >
                {t('memory.forget.button')}
              </Button>
            )
          ) : null}
        </>
      )}
    </section>
  );
}
