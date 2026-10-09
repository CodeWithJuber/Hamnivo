import type { FormAnswers, WidgetFormField } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type FieldValues, prefill } from '../forms.js';
import { BidiText } from './BidiText.js';
import { ChatForm } from './ChatForm.js';

/**
 * Asked before the first conversation starts: the brand's pre-chat form (W26) and, when the
 * visitor must agree first, its words with a box to tick (W27). What the visitor already wrote
 * waits here and goes first once the chat starts; a question field starts with it. "Not now" puts
 * it back in the message box.
 */
export function StartGate(props: {
  fields: readonly WidgetFormField[];
  consent: { text: string; privacyPolicyUrl: string | null } | null;
  /** What the visitor wrote before the chat could start ('' when they asked for a person). */
  pending: string;
  /** Answers given earlier in this visit (kept in memory only). */
  remembered: FieldValues;
  locale: string;
  onSubmit: (answers: FormAnswers, values: FieldValues) => Promise<void>;
  onConsentRequired: () => Promise<void>;
  onValues: (values: FieldValues) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const asksQuestion = props.fields.some((f) => f.kind === 'question');
  const prechat = props.fields.length > 0;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mb-4 flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm"
      data-testid={prechat ? 'prechat' : 'consent-card'}
    >
      <h2
        id={`${id}-title`}
        ref={heading}
        tabIndex={-1}
        className="text-[0.9375rem] font-semibold text-text outline-none"
      >
        {t('surface.gate.title')}
      </h2>
      {props.pending && !asksQuestion ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-text-muted">{t('surface.gate.yourMessage')}</p>
          <p
            className="whitespace-pre-wrap break-words rounded-xl bg-surface-sunken px-3 py-2 text-sm text-text"
            data-testid="pending-message"
          >
            <BidiText text={props.pending} />
          </p>
        </div>
      ) : null}
      <ChatForm
        id={`${id}-form`}
        fields={props.fields}
        initial={{ ...props.remembered, ...prefill(props.fields, props.pending) }}
        locale={props.locale}
        consent={props.consent}
        submit={prechat ? t('surface.gate.start') : t('surface.gate.continue')}
        failed={t('surface.gate.failed')}
        onSubmit={props.onSubmit}
        onConsentRequired={props.onConsentRequired}
        onValues={props.onValues}
        secondary={
          <Button type="button" variant="link" className="h-auto" onClick={props.onCancel}>
            {t('surface.gate.cancel')}
          </Button>
        }
      />
    </section>
  );
}
