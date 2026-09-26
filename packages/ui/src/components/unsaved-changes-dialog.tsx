import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { Button } from './button';

type UnsavedChangesDialogProps = {
  open: boolean;
  title: string;
  description: string;
  saveLabel: string;
  discardLabel: string;
  stayLabel: string;
  onSave: () => void | Promise<void>;
  onDiscard: () => void;
  onStay: () => void;
};

/** Save / Discard / Stay choice when leaving dirty work — work is never dropped silently (HNV-24-05). */
function UnsavedChangesDialog({
  open,
  title,
  description,
  saveLabel,
  discardLabel,
  stayLabel,
  onSave,
  onDiscard,
  onStay,
}: UnsavedChangesDialogProps) {
  const [saving, setSaving] = React.useState(false);
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onStay())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onStay}>{stayLabel}</AlertDialogCancel>
          <Button variant="destructive" onClick={onDiscard}>
            {discardLabel}
          </Button>
          <AlertDialogAction asChild>
            <Button
              busy={saving}
              onClick={async (event) => {
                event.preventDefault();
                setSaving(true);
                try {
                  await onSave();
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saveLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Warns before the tab closes while `dirty` is true (browser-native prompt). */
function useBeforeUnloadGuard(dirty: boolean) {
  React.useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}

export { UnsavedChangesDialog, useBeforeUnloadGuard };
