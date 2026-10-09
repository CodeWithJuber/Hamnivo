import type { FormAnswers, OfflineMessageResponse, WidgetConfig } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { consentNeeded, type FieldValues, labelOf } from '../forms.js';
import { BidiText } from './BidiText.js';
import { ChatForm } from './ChatForm.js';

/** What the visitor reads once the message is sent: the ticket's reference and what comes next. */
export function TicketThanks(props: {
  sent: OfflineMessageResponse;
  thanks: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const { sent } = props;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 text-sm text-text"
      data-testid="ticket-thanks"
    >
      <h2
        id={`${id}-title`}
        ref={heading}
        tabIndex={-1}
        className="text-base font-semibold text-text outline-none"
      >
        {t('surface.contact.sent')}
      </h2>
      <p className="font-medium" data-testid="ticket-reference">
        <BidiText text={t('surface.contact.reference', { reference: sent.reference })} />
      </p>
      {props.thanks ? <p dir="auto">{props.thanks}</p> : null}
      <p>
        <BidiText
          text={t(
            sent.confirmationSent ? 'surface.contact.linkSent' : 'surface.contact.linkSentBefore',
            {
              email: sent.email,
            },
          )}
        />
      </p>
      <Button className="min-h-11 self-start" onClick={props.onBack}>
        {t('surface.contact.backToStart')}
      </Button>
    </section>
  );
}

/**
 * The contact form while nobody can answer (W11): the brand's fields, consent when the visitor
 * must agree first (W27), and one send. The message becomes a ticket (H19) answered by email once
 * the visitor opens the link sent to them. A retry of the same answers reuses the request id, so
 * it creates one ticket; other answers are a new request.
 */
export function ContactForm(props: {
  config: WidgetConfig;
  locale: string;
  /** Answers typed earlier in this visit (kept in memory only). */
  remembered: FieldValues;
  onValues: (values: FieldValues) => void;
  onAgree: () => Promise<void>;
  onLeave: (answers: FormAnswers, clientRequestId: string) => Promise<OfflineMessageResponse>;
  onConsentRequired: () => Promise<void>;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const request = useRef<{ answers: string; id: string } | null>(null);
  const [sent, setSent] = useState<OfflineMessageResponse | null>(null);
  useEffect(() => heading.current?.focus(), []);
  const { config, locale } = props;
  const form = config.forms.offline;
  if (sent) {
    return <TicketThanks sent={sent} thanks={labelOf(form.thanks, locale)} onBack={props.onBack} />;
  }
  const consent = consentNeeded(config)
    ? {
        text: labelOf(config.consent.text, locale),
        privacyPolicyUrl: config.privacyPolicyUrl,
      }
    : null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      data-testid="contact-form"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id={`${id}-title`}
          ref={heading}
          tabIndex={-1}
          className="text-base font-semibold text-text outline-none"
        >
          {t('surface.contact.formTitle')}
        </h2>
        <Button variant="link" className="h-auto" onClick={props.onBack}>
          {t('surface.contact.back')}
        </Button>
      </div>
      <p className="text-sm text-text-muted">{t('surface.contact.body')}</p>
      <ChatForm
        id={`${id}-form`}
        fields={form.fields}
        initial={props.remembered}
        locale={locale}
        consent={consent}
        submit={t('surface.contact.send')}
        failed={t('surface.contact.failed')}
        onValues={props.onValues}
        onConsentRequired={props.onConsentRequired}
        onSubmit={async (answers) => {
          if (consent) await props.onAgree();
          const key = JSON.stringify(answers);
          if (request.current?.answers !== key) {
            request.current = { answers: key, id: crypto.randomUUID() };
          }
          setSent(await props.onLeave(answers, request.current.id));
        }}
      />
    </section>
  );
}
