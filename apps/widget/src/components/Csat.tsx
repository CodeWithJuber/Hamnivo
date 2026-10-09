import type { HamnivoClient } from '@hamnivo/client';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StarIcon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ratedKey, readRated, sendRating } from '../csat.js';
import { Reopen } from './Reopen.js';

/**
 * Asks for a rating from 1 to 5 once a conversation is closed, when the brand wants one. The
 * stars are native radio buttons, so the arrow keys, labels and focus work as everywhere else,
 * and the comment is optional. A rating already sent from this device is thanked, not asked again.
 * Either way the customer can open the conversation again (W15).
 */
export function Csat({
  client,
  conversationId,
  onReopen,
}: {
  client: HamnivoClient;
  conversationId: string;
  onReopen?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const id = useId();
  const [given, setGiven] = useState(() =>
    readRated(client.storage, ratedKey(client.options.widgetId, conversationId)),
  );
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'failed'>('idle');

  if (given !== null) {
    return (
      <div className="flex flex-col gap-2 border-b border-border bg-surface-sunken px-4 py-2">
        <p role="status" className="text-sm text-text" data-testid="csat-thanks">
          {t('appearance.csat.thanks')}
        </p>
        {onReopen ? <Reopen onReopen={onReopen} /> : null}
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (rating === 0) return;
    setPhase('sending');
    try {
      await sendRating(client, conversationId, rating, comment);
      setGiven(rating);
      announce(t('appearance.csat.thanks'));
    } catch {
      setPhase('failed');
      announce(t('appearance.csat.failed'), 'assertive');
    }
  };

  return (
    <form
      className="flex flex-col gap-3 border-b border-border bg-surface-sunken px-4 py-3"
      onSubmit={(event) => void submit(event)}
      data-testid="csat"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text">{t('appearance.csat.title')}</legend>
        <p id={`${id}-hint`} className="text-sm text-text-muted">
          {t('appearance.csat.hint')}
        </p>
        <div className="flex gap-1" aria-describedby={`${id}-hint`}>
          {[1, 2, 3, 4, 5].map((value) => (
            <label key={value} className="relative cursor-pointer">
              <input
                type="radio"
                name={`${id}-rating`}
                value={value}
                checked={rating === value}
                onChange={() => setRating(value)}
                className="peer sr-only"
                aria-label={t('appearance.csat.star', { count: value })}
              />
              <StarIcon
                className={`size-9 rounded-md p-1 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus ${
                  value <= rating ? 'fill-primary text-primary' : 'text-text-muted'
                }`}
                aria-hidden="true"
              />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-comment`} className="text-sm text-text">
          {t('appearance.csat.commentLabel')}
        </label>
        <textarea
          id={`${id}-comment`}
          value={comment}
          maxLength={500}
          rows={2}
          dir="auto"
          onChange={(event) => setComment(event.target.value)}
          className="min-h-11 rounded-xl border border-input bg-bg px-3 py-2 text-base text-text"
        />
      </div>
      {phase === 'failed' ? (
        <p role="alert" className="text-sm text-danger">
          {t('appearance.csat.failed')}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          busy={phase === 'sending'}
          aria-disabled={rating === 0}
          aria-describedby={rating === 0 ? `${id}-choose` : undefined}
        >
          {t('appearance.csat.send')}
        </Button>
        {rating === 0 ? (
          <span id={`${id}-choose`} className="text-sm text-text-muted">
            {t('appearance.csat.chooseFirst')}
          </span>
        ) : null}
      </div>
      {onReopen ? <Reopen onReopen={onReopen} /> : null}
    </form>
  );
}
