import { Button } from '@hamnivo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@hamnivo/ui/components/field';
import { Input } from '@hamnivo/ui/components/input';
import { CheckIcon, ChevronDownIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describedBy } from '../../components/Fields';
import { isApiError } from '../../lib/api';
import { type ListModelsRequest, useProviderModels } from '../../lib/provider-models';
import type { KeyedProvider } from '../../lib/setup';
import { MODEL_CATALOG } from '../../lib/setup-data';

interface Choice {
  id: string;
  /** The provider's friendly name, when its live list gives one. */
  name: string | null;
  deprecated: boolean;
  tier?: 'fast' | 'balanced' | 'capable';
  recommended?: boolean;
}

/** Why there is no live list yet: the key or the server address is still missing. */
export type ModelListWait = 'key' | 'address';

/**
 * The model field: a text box that suggests the models the key can use, read live from the
 * provider (a saved connection's key, the server's own key, or a key pasted before saving), and
 * falls back to a few known models when the list cannot be read. Any name can be typed, so a new
 * or private model never waits for Hamnivo. The list opens under the box, in the page's own flow,
 * so it is never cut off inside a dialog or on a phone (WAI-ARIA combobox with a listbox popup).
 */
export function ModelField({
  id,
  label,
  hint,
  provider,
  value,
  onChange,
  source,
  waitingFor,
  error,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  provider: KeyedProvider | 'mock';
  value: string;
  onChange: (value: string) => void;
  /** What to ask the gateway with; null while there is nothing to ask with yet. */
  source: ListModelsRequest | null;
  /** Says what to fill in first when `source` is null. */
  waitingFor?: ModelListWait | undefined;
  error?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const { t } = useTranslation();
  const listId = `${id}-models`;
  const statusId = `${id}-status`;
  const live = useProviderModels(disabled || provider === 'mock' ? null : source);
  const catalog = provider === 'mock' ? [] : MODEL_CATALOG[provider];
  const known = new Map(catalog.map((model) => [model.id, model]));
  const listed = live.data?.ok ? live.data.models : null;
  const choices: Choice[] = (
    listed ?? catalog.map((model) => ({ id: model.id, name: null, deprecated: false }))
  ).map((model) => {
    const word = known.get(model.id);
    return word
      ? { ...model, tier: word.tier, ...(word.recommended ? { recommended: true } : {}) }
      : model;
  });

  const [open, setOpen] = useState(false);
  // What was typed since the list opened; null shows every model.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Focus that leaves the field closes the list; the list's own options never take focus.
  const leave = (event: { relatedTarget: EventTarget | null }) => {
    if (!wrap.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
  };

  const needle = query?.trim().toLowerCase() ?? '';
  const shown = needle
    ? choices.filter(
        (choice) =>
          choice.id.toLowerCase().includes(needle) || choice.name?.toLowerCase().includes(needle),
      )
    : choices;
  const expanded = open && shown.length > 0 && !disabled;
  const optionId = (index: number) => `${id}-model-${index}`;

  // Escape closes the list, not the dialog around it. Dialogs listen for Escape before the field
  // does, so the list claims it first while it is open.
  useEffect(() => {
    if (!expanded) return;
    const claim = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.target !== box.current) return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', claim, true);
    return () => window.removeEventListener('keydown', claim, true);
  }, [expanded]);

  useEffect(() => {
    if (active >= 0) {
      document.getElementById(`${id}-model-${active}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [active, id]);

  const show = (fresh: boolean) => {
    if (fresh) setQuery(null);
    setActive(-1);
    setOpen(true);
  };
  const choose = (choice: Choice) => {
    onChange(choice.id);
    setQuery(null);
    setOpen(false);
    setActive(-1);
    box.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!expanded) {
        show(true);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + shown.length) % shown.length);
    } else if (event.key === 'Enter' && expanded && active >= 0) {
      event.preventDefault();
      const choice = shown[active];
      if (choice) choose(choice);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const providerName = provider === 'mock' ? '' : t(`editor.providers.${provider}`);
  const status = statusOf();

  function statusOf(): { text: string; busy?: boolean; action?: 'refresh' | 'retry' } | null {
    if (provider === 'mock') return null;
    if (live.isFetching) {
      return { text: t('setup.models.live.loading', { provider: providerName }), busy: true };
    }
    if (live.isError) {
      if (source?.source === 'platform' && isApiError(live.error, 'VALIDATION_FAILED')) {
        return { text: t('setup.models.live.noServerKey') };
      }
      return {
        text: t('setup.models.live.failed', { reason: t('setup.models.live.reasons.request') }),
        action: 'retry',
      };
    }
    if (live.data && !live.data.ok) {
      const kind = live.data.kind === 'ok' ? 'unknown' : live.data.kind;
      return {
        text: t('setup.models.live.failed', { reason: t(`setup.models.live.reasons.${kind}`) }),
        action: 'retry',
      };
    }
    if (listed) {
      return { text: t('setup.models.live.loaded', { count: listed.length }), action: 'refresh' };
    }
    if (!source && waitingFor) return { text: t(`setup.models.live.waiting.${waitingFor}`) };
    return catalog.length > 0 ? { text: t('setup.models.live.suggested') } : null;
  }

  return (
    <Field data-invalid={error ? true : undefined} className="gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div ref={wrap} className="flex flex-col gap-1">
        <div className="relative">
          <Input
            ref={box}
            id={id}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={[describedBy(id, hint, error), status ? statusId : null]
              .filter(Boolean)
              .join(' ')}
            value={value}
            placeholder={t('setup.models.live.placeholder')}
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            maxLength={200}
            disabled={disabled}
            className={choices.length > 0 ? 'pe-11' : undefined}
            onClick={() => show(true)}
            onBlur={leave}
            onKeyDown={onKeyDown}
            onChange={(event) => {
              onChange(event.target.value);
              setQuery(event.target.value);
              setActive(-1);
              setOpen(true);
            }}
          />
          {choices.length > 0 ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('setup.models.live.show')}
              aria-controls={listId}
              aria-expanded={expanded}
              disabled={disabled}
              className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-text-secondary hover:text-text disabled:opacity-50"
              onMouseDown={(event) => event.preventDefault()}
              onBlur={leave}
              onClick={() => {
                if (expanded) setOpen(false);
                else show(true);
                box.current?.focus();
              }}
            >
              <ChevronDownIcon
                className={`size-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
          ) : null}
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label={t('setup.models.live.listLabel')}
          hidden={!expanded}
          className="max-h-72 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-sm"
          data-testid={`${id}-list`}
        >
          {expanded
            ? shown.map((choice, index) => {
                const selected = choice.id === value;
                const notes = [
                  choice.tier ? t(`setup.models.tiers.${choice.tier}`) : null,
                  choice.recommended ? t('setup.models.recommended') : null,
                  choice.deprecated ? t('setup.models.live.deprecated') : null,
                ].filter(Boolean);
                return (
                  <div
                    key={choice.id}
                    id={optionId(index)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    className={`flex min-h-11 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${
                      index === active
                        ? 'bg-surface-sunken ring-1 ring-ring'
                        : 'hover:bg-surface-sunken'
                    }`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(choice)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        choose(choice);
                      }
                    }}
                  >
                    <CheckIcon
                      className={`size-4 shrink-0 ${selected ? 'opacity-100' : 'opacity-0'}`}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-text">
                        {choice.name ?? choice.id}
                      </span>
                      {choice.name || notes.length > 0 ? (
                        <span className="truncate text-xs text-text-secondary" dir="auto">
                          {[choice.name ? choice.id : null, ...notes].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })
            : null}
        </div>
        {open && needle && shown.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('setup.models.live.noMatch')}</p>
        ) : null}
      </div>
      {status ? (
        <p
          id={statusId}
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary"
        >
          {status.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
          <span>{status.text}</span>
          {status.action ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto min-h-6 gap-1 p-0"
              onClick={() => void live.refresh()}
            >
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              {status.action === 'refresh'
                ? t('setup.models.live.refresh')
                : t('setup.models.live.retry')}
            </Button>
          ) : null}
        </p>
      ) : null}
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}
