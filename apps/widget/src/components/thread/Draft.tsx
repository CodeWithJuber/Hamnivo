import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Draft, draftText } from '../../drafts.js';
import { Avatar } from './Avatar.js';
import { Markdown } from './Markdown.js';

/** Without a new piece for this long, the answer is no longer being written but being checked. */
const CHECKING_AFTER_MS = 1500;

/**
 * An answer while it is written (HNV-05-03). It reads like an answer, with a caret after its
 * last word, but stays marked as not final: it becomes a message only when the gateway publishes
 * it, and the gateway can still withdraw it. Its words are not read out one piece at a time; the
 * published answer is announced once.
 */
export function DraftBubble(props: {
  draft: Draft;
  name: string;
  role: string;
  logoUrl: string | null;
}) {
  const { t } = useTranslation();
  // The caret sits after the last word, not on a line of its own after a trailing space.
  const text = draftText(props.draft).trimEnd();
  const [checking, setChecking] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every new piece restarts the wait
  useEffect(() => {
    setChecking(false);
    const timer = setTimeout(() => setChecking(true), CHECKING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <li
      className="flex gap-2"
      data-state="provisional"
      data-testid="draft-reply"
      aria-busy="true"
      aria-live="off"
    >
      <span className="w-8 shrink-0 max-[20rem]:hidden" aria-hidden="true">
        <Avatar kind="ai_primary" name={props.name} logoUrl={props.logoUrl} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        {props.name ? (
          <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
            <span className="font-semibold text-text">{props.name}</span>
            <span className="font-medium text-info">{props.role}</span>
          </p>
        ) : null}
        <Markdown
          text={text}
          streaming={!checking}
          className="max-w-[92%] break-words rounded-xl rounded-es-sm border border-dashed border-input bg-surface px-3.5 py-2 text-[0.9375rem] leading-relaxed text-text"
        />
        <p className="text-xs text-text-muted" data-testid="draft-status">
          {checking ? t('draftChecking') : t('ui.writing')}
        </p>
      </div>
    </li>
  );
}
