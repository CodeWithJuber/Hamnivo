import { useTranslation } from 'react-i18next';
import type { LiveRun } from '../../run.js';
import { Avatar } from './Avatar.js';

/**
 * A reply is on its way: three dots beside the assistant's picture, and what it is doing when
 * the gateway says so ("Searching the help articles…"). It is not read out: the reply itself is
 * announced when it arrives, and a status that repeats would only get in its way.
 */
export function Thinking(props: { run: LiveRun | null; logoUrl: string | null }) {
  const { t } = useTranslation();
  const step = props.run?.step ?? null;
  const words = step ? t(`ui.run.${step}`) : (props.run?.label ?? null);
  return (
    <li className="hv-enter flex items-end gap-2" data-testid="ai-writing" aria-live="off">
      <span className="w-8 shrink-0 max-[20rem]:hidden" aria-hidden="true">
        <Avatar kind="ai_primary" name="" logoUrl={props.logoUrl} />
      </span>
      <div className="flex min-w-0 flex-col items-start gap-1">
        <div className="rounded-xl rounded-es-sm border border-border bg-surface px-3.5 py-3 text-text-muted shadow-sm">
          <span className="hv-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="sr-only">{t('typing')}</span>
        </div>
        {words ? (
          <p className="hv-fade text-xs text-text-muted" data-testid="run-step" dir="auto">
            {words}
          </p>
        ) : null}
      </div>
    </li>
  );
}
