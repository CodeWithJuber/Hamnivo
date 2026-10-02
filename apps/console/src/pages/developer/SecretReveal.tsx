import { Button } from '@hamnivo/ui/components/button';
import { CircleCheckIcon, ShieldAlertIcon } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { CopyButton } from '../../components/CopyButton';

/**
 * Shows a new API key or signing secret once. The value lives only in this dialog's props: when
 * it closes, the page forgets it, and no list or reload can show it again.
 */
export function SecretReveal({
  secret,
  title,
  label,
  onDone,
  testId,
}: {
  secret: string | null;
  title: string;
  /** What the value is, e.g. "API key" or "Signing secret". */
  label: string;
  onDone: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const valueRef = useRef<HTMLElement>(null);
  return (
    <AppDialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
      title={
        <span className="flex items-center gap-2">
          <CircleCheckIcon className="size-5 text-success" aria-hidden="true" />
          {title}
        </span>
      }
      description={t('developer.reveal.description')}
      testId={testId}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium text-text" id={`${testId}-label`}>
          {label}
        </p>
        <code
          ref={valueRef}
          data-testid={`${testId}-value`}
          dir="ltr"
          className="block break-all rounded-lg border border-border bg-surface-sunken p-3 text-start font-mono text-sm text-text select-all"
        >
          {secret}
        </code>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton
            text={secret ?? ''}
            label={t('developer.reveal.copy')}
            copiedLabel={t('developer.reveal.copied')}
            failedLabel={t('developer.reveal.copyFailed')}
            selectTarget={() => valueRef.current}
            testId={`${testId}-copy`}
          />
        </div>
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-text">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          {t('developer.reveal.once')}
        </p>
      </div>
      <DialogFooter>
        <Button onClick={onDone} data-testid={`${testId}-done`}>
          {t('developer.reveal.done')}
        </Button>
      </DialogFooter>
    </AppDialog>
  );
}
