import { Button } from '@hamnivo/ui/components/button';
import { DownloadIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * A picture from the conversation, as large as the chat allows. It is a dialog: focus stays in
 * it, Escape or a press beside the picture closes it and gives focus back to where it was, and
 * Escape then does not close the chat as well.
 */
export default function Lightbox(props: {
  url: string;
  name: string;
  /** What the picture is, for its alternative text and the dialog's name. */
  label: string;
  closeLabel: string;
  downloadLabel: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => before?.focus?.();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = [...(dialog.current?.querySelectorAll<HTMLElement>('a[href], button') ?? [])];
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={props.label}
      className="hv-fade fixed inset-0 z-50 flex flex-col gap-3 bg-overlay p-3"
      data-testid="lightbox"
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="flex justify-end gap-2">
        <Button asChild variant="secondary" size="sm" className="min-h-10">
          <a href={props.url} download={props.name}>
            <DownloadIcon className="size-4" aria-hidden="true" />
            {props.downloadLabel}
          </a>
        </Button>
        <Button
          ref={close}
          variant="secondary"
          size="icon"
          aria-label={props.closeLabel}
          title={props.closeLabel}
          onClick={props.onClose}
        >
          <XIcon className="size-5" aria-hidden="true" />
        </Button>
      </div>
      <img
        src={props.url}
        alt={props.label}
        className="m-auto min-h-0 max-w-full flex-1 rounded-lg object-contain"
      />
    </div>,
    document.body,
  );
}
