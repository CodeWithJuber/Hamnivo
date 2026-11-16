import { REACTIONS, type ReactionEmoji } from '@hamnivo/contracts';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { CheckIcon, CopyIcon, SmilePlusIcon, ThumbsDownIcon, ThumbsUpIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '../../clipboard.js';
import { EMOJI_NAMES } from '../MessageActions.js';

const tool =
  'inline-flex size-8 items-center justify-center rounded-md text-text-muted outline-none hover:bg-surface-sunken hover:text-text focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-pressed:bg-surface-sunken aria-pressed:text-text';

function Tool(props: {
  label: string;
  pressed?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={tool}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/**
 * What a visitor can do with a reply: copy it, say whether it helped, or react with another
 * emoji (W22). "Helpful" and "Not helpful" are the 👍 and 👎 reactions, so staff read them next to
 * the reply like any other. The other emoji open in a row inside the message itself.
 */
export function Toolbar(props: {
  /** The reply's words, for copying; empty when there is nothing to copy. */
  text: string;
  /** Whether this visitor may react to this message. */
  canReact: boolean;
  /** What the visitor already gave it. */
  given: readonly ReactionEmoji[];
  onReact: (emoji: ReactionEmoji) => Promise<void>;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const nameOf = (emoji: ReactionEmoji) => t(`surface.actions.emoji.${EMOJI_NAMES[emoji]}`);

  const copy = async () => {
    const done = await copyText(props.text);
    announce(t(done ? 'ui.copied' : 'ui.copyFailed'));
    if (!done) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const react = async (emoji: ReactionEmoji) => {
    setBusy(true);
    setFailed(false);
    try {
      await props.onReact(emoji);
      setOpen(false);
      announce(t('surface.actions.reacted', { emoji: nameOf(emoji) }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const has = (emoji: ReactionEmoji) => props.given.includes(emoji);

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center">
        {props.text ? (
          <Tool label={t(copied ? 'ui.copied' : 'ui.copy')} onClick={() => void copy()}>
            {copied ? (
              <CheckIcon className="size-4" aria-hidden="true" />
            ) : (
              <CopyIcon className="size-4" aria-hidden="true" />
            )}
          </Tool>
        ) : null}
        {props.canReact ? (
          <>
            <Tool
              label={t('ui.helpful')}
              pressed={has('👍')}
              disabled={busy || has('👍')}
              onClick={() => void react('👍')}
            >
              <ThumbsUpIcon className="size-4" aria-hidden="true" />
            </Tool>
            <Tool
              label={t('ui.notHelpful')}
              pressed={has('👎')}
              disabled={busy || has('👎')}
              onClick={() => void react('👎')}
            >
              <ThumbsDownIcon className="size-4" aria-hidden="true" />
            </Tool>
            <Tool
              label={t('surface.actions.reactTo')}
              expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              <SmilePlusIcon className="size-4" aria-hidden="true" />
            </Tool>
          </>
        ) : null}
      </div>
      {open ? (
        <ul
          className="hv-pop flex flex-wrap gap-1 rounded-full border border-border bg-surface p-1 shadow-md"
          data-testid="reactions"
        >
          {REACTIONS.filter((emoji) => emoji !== '👍' && emoji !== '👎').map((emoji) => (
            <li key={emoji}>
              <button
                type="button"
                className="inline-flex size-10 items-center justify-center rounded-full text-lg outline-none hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                disabled={busy}
                aria-label={nameOf(emoji)}
                onClick={() => void react(emoji)}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {failed ? (
        <p role="alert" className="text-xs text-danger">
          {t('surface.actions.reactFailed')}
        </p>
      ) : null}
    </div>
  );
}
