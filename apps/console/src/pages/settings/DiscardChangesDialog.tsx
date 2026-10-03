import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@hamnivo/ui/components/alert-dialog';
import { Button } from '@hamnivo/ui/components/button';
import { useBlocker } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

/**
 * Asks before changes that are not saved are thrown away: keep editing, or discard them. Nothing
 * a person typed is dropped without this question (HNV-24-05).
 */
export function DiscardChangesDialog({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep();
      }}
    >
      <AlertDialogContent data-testid="discard-changes">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('setup.leave.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('setup.leave.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onKeep}>{t('setup.leave.keep')}</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button variant="destructive" onClick={onDiscard}>
              {t('setup.leave.discard')}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Stops a page with changes that are not saved from being left (by a link, the back button or
 * closing the tab) without asking first.
 */
export function LeaveGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  return (
    <DiscardChangesDialog
      open={blocker.status === 'blocked'}
      onKeep={() => blocker.reset?.()}
      onDiscard={() => blocker.proceed?.()}
    />
  );
}
