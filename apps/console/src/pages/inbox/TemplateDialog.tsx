import { Button } from '@hamnivo/ui/components/button';
import { Input } from '@hamnivo/ui/components/input';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import type { TFunction } from 'i18next';
import { ArrowLeftIcon, SendIcon } from 'lucide-react';
import { type FormEvent, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { TextField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { ActionError } from '../../components/States';
import { isApiError } from '../../lib/api';
import { DOCS } from '../../lib/docs';
import { formatRelative } from '../../lib/format';
import {
  type InboxDetail,
  newClientId,
  type TemplateSend,
  useWhatsappTemplates,
  type WhatsappTemplate,
} from '../../lib/inbox';
import { isCancelled } from '../../lib/reauth';
import {
  byLanguage,
  COPY_CODE_MAX,
  languageName,
  matchTemplates,
  prefill,
  previewPieces,
  type TemplateField,
  templateFields,
  templateValues,
  unfilled,
} from '../../lib/whatsapp-templates';

type Category = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
const CATEGORIES = new Set<string>(['UTILITY', 'MARKETING', 'AUTHENTICATION']);

function CategoryLabel({ category }: { category: string }) {
  const { t } = useTranslation();
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
      {CATEGORIES.has(category)
        ? t(`channels.templates.category.${category as Category}`)
        : t('channels.templates.category.other')}
    </span>
  );
}

/** Header, body and footer with the values in; a value not filled in yet shows as `{{2}}`. */
function Preview({
  template,
  values,
}: {
  template: WhatsappTemplate;
  values: Record<string, string>;
}) {
  const { t } = useTranslation();
  const text = (source: string, part: 'header' | 'body') =>
    previewPieces(source, part, values).map((piece, index) =>
      piece.variable === undefined ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces never move
        <span key={index}>{piece.text}</span>
      ) : piece.filled ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces never move
        <span key={index} className="font-medium">
          {piece.text}
        </span>
      ) : (
        <mark
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces never move
          key={index}
          className="rounded-sm bg-warning-subtle px-0.5 font-mono text-text"
          data-testid="preview-unfilled"
        >
          <bdi dir="ltr">{piece.text}</bdi>
        </mark>
      ),
    );
  return (
    <section aria-labelledby="template-preview-title" className="flex flex-col gap-2">
      <h3 id="template-preview-title" className="text-sm font-semibold text-text">
        {t('channels.templates.preview')}
      </h3>
      <div
        className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text"
        data-testid="template-preview"
        dir="auto"
      >
        {template.header ? (
          <p className="font-semibold" data-testid="preview-header">
            {text(template.header, 'header')}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap" data-testid="preview-body">
          {text(template.body, 'body')}
        </p>
        {template.footer ? (
          <p className="text-xs text-text-secondary" data-testid="preview-footer">
            {template.footer}
          </p>
        ) : null}
        {template.buttons.length > 0 ? (
          <ul className="flex flex-wrap gap-2 border-t border-border pt-2">
            {template.buttons.map((button, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: buttons keep their order
                key={index}
                className="rounded-md border border-border bg-bg px-2 py-1 text-xs font-medium"
              >
                {button.text}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function TemplateList({
  templates,
  onPick,
}: {
  templates: WhatsappTemplate[];
  onPick: (template: WhatsappTemplate) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  return (
    <div className="flex flex-col gap-4">
      {byLanguage(templates).map((group, groupIndex) => (
        <section
          key={group.language}
          aria-labelledby={`${id}-${groupIndex}`}
          className="flex flex-col gap-1"
        >
          <h3 id={`${id}-${groupIndex}`} className="text-xs font-semibold text-text-secondary">
            {languageName(group.language, i18n.resolvedLanguage ?? 'en')}
          </h3>
          <ul className="flex flex-col gap-1">
            {group.templates.map((template) => {
              const reason = template.unsupported
                ? t(`channels.templates.unsupported.${template.unsupported}`)
                : null;
              return (
                <li key={`${template.name}:${template.language}`}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-1 rounded-md p-2 text-start hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent"
                    aria-disabled={reason ? true : undefined}
                    onClick={() => {
                      if (!reason) onPick(template);
                    }}
                    data-testid="template-option"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <bdi dir="ltr" className="font-mono text-sm font-medium text-text">
                        {template.name}
                      </bdi>
                      <CategoryLabel category={template.category} />
                    </span>
                    <span
                      className={
                        reason
                          ? 'line-clamp-2 text-sm text-text-secondary'
                          : 'line-clamp-2 text-sm text-text'
                      }
                    >
                      <bdi dir="auto">{template.body}</bdi>
                    </span>
                    {reason ? (
                      <span className="text-xs font-medium text-text" data-testid="template-reason">
                        {reason}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function fieldLabel(t: TFunction, field: TemplateField) {
  if (field.part === 'buttons')
    return t('channels.templates.fields.button', { label: field.label ?? '' });
  const variable = `{{${field.name}}}`;
  return field.part === 'header'
    ? t('channels.templates.fields.header', { variable })
    : t('channels.templates.fields.body', { variable });
}

const fieldId = (key: string) => `template-${key.replace('.', '-')}`;

/** Our own words for the server's field messages where we can tell which it is. */
function fieldError(t: TFunction, field: TemplateField, value: string, server: string) {
  if (!value.trim()) return t('channels.templates.errors.required');
  if (field.button === 'copy_code' && value.trim().length > COPY_CODE_MAX) {
    return t('channels.templates.errors.code');
  }
  return server;
}

function TemplateForm({
  detail,
  template,
  onBack,
  onSend,
  onSent,
}: {
  detail: InboxDetail;
  template: WhatsappTemplate;
  onBack: () => void;
  onSend: (template: TemplateSend, clientMessageId: string) => Promise<unknown>;
  onSent: () => void;
}) {
  const { t, i18n } = useTranslation();
  const fields = useMemo(() => templateFields(template), [template]);
  const filledIn = useMemo(() => prefill(template, detail), [template, detail]);
  const [values, setValues] = useState<Record<string, string>>(filledIn);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // The same values keep the same message id, so a retry after a lost answer sends once.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const missing = unfilled(fields, values);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || missing.length > 0) return;
    const send: TemplateSend = {
      name: template.name,
      language: template.language,
      values: templateValues(fields, values),
    };
    const key = JSON.stringify(send);
    if (attempt.current?.key !== key) attempt.current = { key, id: newClientId() };
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await onSend(send, attempt.current.id);
      onSent();
    } catch (caught) {
      setBusy(false);
      if (isCancelled(caught)) return;
      const byField: Record<string, string> = {};
      if (isApiError(caught, 'VALIDATION_FAILED')) {
        for (const item of caught.fields) {
          const key = item.path.replace(/^template\.values\./, '');
          const field = fields.find((f) => f.key === key);
          if (field) byField[key] = fieldError(t, field, values[key] ?? '', item.message);
        }
      }
      setErrors(byField);
      const first = fields.find((f) => byField[f.key]);
      if (first) document.getElementById(fieldId(first.key))?.focus();
      else setError(caught);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate data-testid="template-form">
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={onBack}
          data-testid="template-back"
        >
          <ArrowLeftIcon className="rtl:-scale-x-100" aria-hidden="true" />
          {t('channels.templates.back')}
        </Button>
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
          <bdi dir="ltr" className="font-mono" data-testid="template-name">
            {template.name}
          </bdi>
          <CategoryLabel category={template.category} />
          <span className="text-xs font-normal text-text-secondary">
            {languageName(template.language, i18n.resolvedLanguage ?? 'en')}
          </span>
        </h3>
      </div>
      {fields.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('channels.templates.fields.none')}</p>
      ) : (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-semibold text-text">
            {t('channels.templates.fields.title')}
          </legend>
          {fields.map((field) => {
            const value = values[field.key] ?? '';
            const prefilled = Boolean(filledIn[field.key]) && value === filledIn[field.key];
            const hint =
              field.button === 'copy_code'
                ? t('channels.templates.fields.code')
                : field.button === 'url'
                  ? t('channels.templates.fields.url')
                  : prefilled
                    ? t('channels.templates.fields.prefilled')
                    : undefined;
            return (
              <TextField
                key={field.key}
                id={fieldId(field.key)}
                label={fieldLabel(t, field)}
                hint={hint}
                value={value}
                maxLength={field.button === 'copy_code' ? COPY_CODE_MAX : 1000}
                {...(field.button ? { dir: 'ltr', spellCheck: false } : {})}
                onChange={(event) => {
                  const next = event.target.value;
                  setValues((current) => ({ ...current, [field.key]: next }));
                  setErrors(({ [field.key]: _, ...rest }) => rest);
                }}
                error={errors[field.key]}
                data-testid={`template-field-${field.key}`}
              />
            );
          })}
        </fieldset>
      )}
      <Preview template={template} values={values} />
      <ActionError error={error} />
      <DialogFooter>
        <ReasonedAction
          reason={
            missing.length > 0 ? t('channels.templates.missing', { count: missing.length }) : null
          }
        >
          <Button type="submit" busy={busy} data-testid="send-template">
            <SendIcon className="rtl:-scale-x-100" aria-hidden="true" />
            {t('channels.templates.send')}
          </Button>
        </ReasonedAction>
      </DialogFooter>
    </form>
  );
}

/**
 * Send a WhatsApp template (D14): after 24 hours without a message from the customer, WhatsApp
 * delivers only templates Meta approved. Pick one (grouped by language, ones Hamnivo cannot send
 * shown with why), fill in its values, check the preview and send.
 */
export function TemplateDialog({
  open,
  onOpenChange,
  detail,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: InboxDetail;
  onSend: (template: TemplateSend, clientMessageId: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<WhatsappTemplate | null>(null);
  const list = useWhatsappTemplates(detail.id, open);
  const items = list.data?.items ?? [];
  const shown = matchTemplates(items, q);

  const change = (next: boolean) => {
    if (!next) {
      setPicked(null);
      setQ('');
    }
    onOpenChange(next);
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={change}
      title={t('channels.templates.title')}
      description={t('channels.templates.description')}
      className="sm:max-w-xl"
      testId="template-dialog"
    >
      {picked ? (
        <TemplateForm
          key={`${picked.name}:${picked.language}`}
          detail={detail}
          template={picked}
          onBack={() => setPicked(null)}
          onSend={onSend}
          onSent={() => change(false)}
        />
      ) : list.isPending ? (
        <p className="text-sm text-text-secondary" aria-busy="true">
          {t('channels.templates.loading')}
        </p>
      ) : list.error ? (
        <ActionError error={list.error} />
      ) : (
        <div className="flex flex-col gap-3">
          {items.length === 0 ? (
            <div className="flex flex-col gap-2 text-sm" data-testid="templates-empty">
              <p className="font-semibold text-text">{t('channels.templates.empty.title')}</p>
              <p className="text-text-secondary">{t('channels.templates.empty.description')}</p>
              <GuideLink href={`${DOCS.setup.whatsappChannel}#template-messages`}>
                {t('channels.templates.empty.guide')}
              </GuideLink>
            </div>
          ) : (
            <>
              <Input
                type="search"
                value={q}
                onChange={(event) => setQ(event.target.value)}
                aria-label={t('channels.templates.search')}
                placeholder={t('channels.templates.search')}
                dir={q ? 'auto' : undefined}
                data-testid="template-search"
              />
              {shown.length === 0 ? (
                <p className="text-sm text-text-secondary" role="status">
                  {t('channels.templates.noMatch', { query: q.trim() })}
                </p>
              ) : (
                <TemplateList templates={shown} onPick={setPicked} />
              )}
            </>
          )}
          <p className="text-xs text-text-secondary" data-testid="templates-synced">
            {list.data?.lastSyncedAt ? (
              <>
                {t('channels.templates.synced', {
                  time: formatRelative(list.data.lastSyncedAt),
                })}{' '}
              </>
            ) : null}
            {t('channels.templates.syncHint')}
          </p>
        </div>
      )}
    </AppDialog>
  );
}
