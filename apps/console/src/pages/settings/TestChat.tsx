import { Button } from '@hamnivo/ui/components/button';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { testChatUrl } from '../../lib/setup';
import type { Brand } from '../../lib/types';

/**
 * The real chat for a brand, running inside Studio. The address asks for a test session: the
 * gateway lets Studio's own page frame the chat for that, gives it a session of its own (so a
 * test never mixes with a real customer's chat on this browser) and marks what it starts as a
 * test, which reports and counts leave out.
 */
export function TestChatFrame({
  widgetId,
  name,
  className = 'h-[560px]',
}: {
  widgetId: string;
  name: string;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  return (
    <iframe
      title={t('setup.testChat.frameTitle', { name })}
      src={testChatUrl(widgetId, i18n.language)}
      data-testid="test-chat-frame"
      className={`block w-full rounded-lg border border-border bg-white ${className}`}
    />
  );
}

/** What a test chat does and does not do, in the words an owner needs before trying it. */
export function TestChatNotes() {
  const { t } = useTranslation();
  return (
    <ul className="list-disc ps-5 text-sm text-text-secondary" data-testid="test-chat-notes">
      <li>{t('setup.testChat.noteReal')}</li>
      <li>{t('setup.testChat.noteReports')}</li>
      <li>{t('setup.testChat.noteUsage')}</li>
    </ul>
  );
}

export function TestChatDialog({
  brand,
  open,
  onOpenChange,
}: {
  brand: Brand;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('setup.testChat.title', { name: brand.name })}
      description={t('setup.testChat.description')}
      className="sm:max-w-2xl"
      testId="test-chat-dialog"
    >
      <TestChatFrame widgetId={brand.widgetId} name={brand.name} />
      <TestChatNotes />
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
          {t('app.close')}
        </Button>
      </DialogFooter>
    </AppDialog>
  );
}
