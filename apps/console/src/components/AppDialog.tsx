import { Button, type ButtonProps } from '@hamnivo/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@hamnivo/ui/components/dialog';
import { cn } from '@hamnivo/ui/lib/utils';
import { XIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { returnFocus, useOpener } from '../lib/focus';
import { isCancelled } from '../lib/reauth';
import { ActionError } from './States';

/**
 * A modal dialog: title, optional description, content and a close button on the logical end
 * side (so it mirrors in right-to-left). Focus is trapped inside and returns to the control that
 * opened it (HNV-24-04).
 */
export function AppDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  fallbackFocus,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Where focus goes when the control that opened the dialog is gone (default: page heading). */
  fallbackFocus?: () => HTMLElement | null;
  testId?: string;
}) {
  const { t } = useTranslation();
  const opener = useOpener(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid={testId}
        className={cn('max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg', className)}
        {...(description ? {} : { 'aria-describedby': undefined })}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus(opener.current, fallbackFocus);
        }}
      >
        <DialogHeader className="pe-10 text-start sm:text-start">
          <DialogTitle className="leading-snug">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-text-secondary">{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute end-3 top-3"
            aria-label={t('app.close')}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

export { DialogFooter };

/**
 * Asks before a change with consequences. The confirm button shows progress and cannot be sent
 * twice; a failure stays in the dialog with its reason, and nothing closes until it succeeds.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  variant = 'default',
  onConfirm,
  testId,
  fallbackFocus,
  failureNote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  variant?: ButtonProps['variant'];
  onConfirm: () => Promise<unknown>;
  testId?: string;
  fallbackFocus?: () => HTMLElement | null;
  /** Says what stayed as it was when the change failed (e.g. "The live version didn't change"). */
  failureNote?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);

  const change = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setError(null);
      setCancelled(false);
    }
    onOpenChange(next);
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={change}
      title={title}
      {...(testId ? { testId } : {})}
      {...(fallbackFocus ? { fallbackFocus } : {})}
    >
      <div className="flex flex-col gap-3 text-sm text-text">{children}</div>
      {cancelled ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('app.cancelled')}
        </p>
      ) : null}
      {error && failureNote ? <p className="text-sm font-medium text-text">{failureNote}</p> : null}
      <ActionError error={error} />
      <DialogFooter>
        <Button variant="secondary" onClick={() => change(false)} disabled={busy}>
          {t('app.cancel')}
        </Button>
        <Button
          variant={variant}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setCancelled(false);
            try {
              await onConfirm();
              setBusy(false);
              onOpenChange(false);
            } catch (caught) {
              setBusy(false);
              if (isCancelled(caught)) setCancelled(true);
              else setError(caught);
            }
          }}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </AppDialog>
  );
}
