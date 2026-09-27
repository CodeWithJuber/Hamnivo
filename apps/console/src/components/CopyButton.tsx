import { Button, type ButtonProps } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Copies text and says so in words next to the button and to screen readers. When the browser
 * refuses (plain-HTTP pages), it selects the text so the person can copy it themselves.
 */
export function CopyButton({
  text,
  label,
  copiedLabel,
  failedLabel,
  selectTarget,
  variant = 'secondary',
  size = 'sm',
  testId,
}: {
  text: string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
  /** Element whose text is selected when copying fails. */
  selectTarget?: () => HTMLElement | null;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  testId?: string;
}) {
  const announce = useAnnouncer();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 4000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant={variant}
        size={size}
        data-testid={testId}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState('copied');
            announce(copiedLabel);
          } catch {
            setState('failed');
            announce(failedLabel, 'assertive');
            const target = selectTarget?.();
            if (target) {
              const range = document.createRange();
              range.selectNodeContents(target);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
            }
          }
        }}
      >
        {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        {label}
      </Button>
      {state === 'copied' ? (
        <span
          className="text-sm text-success"
          data-testid={testId ? `${testId}-status` : undefined}
        >
          {copiedLabel}
        </span>
      ) : state === 'failed' ? (
        <span className="text-sm text-danger">{failedLabel}</span>
      ) : null}
    </span>
  );
}
