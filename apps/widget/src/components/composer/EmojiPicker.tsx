import { type KeyboardEvent, useEffect, useRef } from 'react';

/** A small set for a support chat: faces, hands, and the things people write to a shop about. */
const EMOJI = [
  '😀',
  '😊',
  '😂',
  '🙂',
  '😉',
  '😍',
  '🤔',
  '😅',
  '😢',
  '😡',
  '👍',
  '👎',
  '🙏',
  '👏',
  '🙌',
  '👋',
  '💪',
  '🤝',
  '❤️',
  '🎉',
  '🔥',
  '✅',
  '❌',
  '⭐',
  '💡',
  '📦',
  '🛒',
  '💳',
  '📧',
  '📞',
  '⏰',
  '📍',
  '🚚',
  '🔒',
  '⚠️',
  '❓',
] as const;

const COLUMNS = 6;

/**
 * Emoji for the message box (roadmap, everyday expectations). Arrow keys move between them, as
 * in a grid; Escape puts it away and gives focus back to its button, without closing the chat.
 */
export default function EmojiPicker(props: {
  label: string;
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    grid.current?.querySelector('button')?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    // "Right" is the next one where text runs left to right, the one before in Arabic and Urdu.
    const forward = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
    const step =
      event.key === 'ArrowRight'
        ? forward
        : event.key === 'ArrowLeft'
          ? -forward
          : event.key === 'ArrowDown'
            ? COLUMNS
            : event.key === 'ArrowUp'
              ? -COLUMNS
              : 0;
    if (step === 0) return;
    const buttons = [...(grid.current?.querySelectorAll('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[index + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not a form's fieldset
    <div
      ref={grid}
      role="group"
      aria-label={props.label}
      className="hv-pop absolute end-0 bottom-full z-20 mb-2 grid max-w-full grid-cols-6 gap-0.5 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
      data-testid="emoji-picker"
      onKeyDown={onKeyDown}
    >
      {EMOJI.map((emoji, index) => (
        <button
          key={emoji}
          type="button"
          // One stop for the Tab key; the arrows move inside.
          tabIndex={index === 0 ? 0 : -1}
          className="flex size-10 items-center justify-center rounded-md text-xl outline-none hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => props.onPick(emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
