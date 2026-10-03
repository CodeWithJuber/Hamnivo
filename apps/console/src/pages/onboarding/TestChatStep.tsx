import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useAuthorityConnections } from '../../lib/queries';
import type { Brand } from '../../lib/types';
import { connectionFor } from '../OverviewPage';
import { TestChatFrame, TestChatNotes } from '../settings/TestChat';

/**
 * Step 5: try the real chat, inside Studio, before any website has it. It needs the chat engine
 * for the brand; without it, the step says so and points back to it.
 */
export function TestChatStep({
  brand,
  onDone,
}: {
  brand: Brand;
  onDone: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const connections = useAuthorityConnections();
  const connection = connectionFor(connections.data?.items, brand.id);
  // Someone who cannot see the connection is let try: the chat itself says if it is not ready.
  const engineMissing = connections.data !== undefined && !connection;

  if (engineMissing) {
    return (
      <div className="flex flex-col gap-3" data-testid="testchat-needs-engine">
        <p className="text-sm text-text">{t('setup.testChat.needsEngine')}</p>
        <div>
          <Button asChild variant="secondary">
            <Link to="/onboarding" search={{ step: 'engine' }}>
              {t('setup.onboarding.testchat.toEngine')}
            </Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-testchat">
      <TestChatFrame widgetId={brand.widgetId} name={brand.name} className="h-[480px]" />
      <TestChatNotes />
      <div>
        <Button type="button" onClick={() => void onDone()}>
          {t('setup.onboarding.testchat.done')}
        </Button>
      </div>
    </div>
  );
}
