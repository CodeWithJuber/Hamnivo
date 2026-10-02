import { Button } from '@hamnivo/ui/components/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@hamnivo/ui/components/tabs';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ExternalLinkIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';
import { Forbidden } from '../../components/States';
import { GATEWAY_ORIGIN } from '../../lib/config';
import { useTenant } from '../../lib/tenant';
import type { DeveloperSearch, DeveloperTab } from '../../routes/_studio/developer';
import { AllowedHostsTab } from './AllowedHostsTab';
import { ApiKeysTab } from './ApiKeysTab';
import { EventLogTab } from './EventLogTab';
import { WebhooksTab } from './WebhooksTab';

const TAB = 'text-text-secondary hover:text-text data-[state=active]:text-text';

/** Developer settings (board 19): API keys, webhooks, their event log and the allowed hosts. */
export function DeveloperPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/developer' });
  const navigate = useNavigate({ from: '/developer' });
  const visible: Record<DeveloperTab, boolean> = {
    keys: can('api_keys.read'),
    webhooks: can('webhooks.read'),
    events: can('webhooks.read'),
    hosts: can('webhooks.read') || can('network.manage'),
  };
  const tabs = (Object.keys(visible) as DeveloperTab[]).filter((tab) => visible[tab]);
  const tab: DeveloperTab =
    search.tab && visible[search.tab] ? search.tab : (tabs[0] ?? 'webhooks');
  const select = (next: string) =>
    void navigate({
      search: (): DeveloperSearch => ({ tab: next as DeveloperTab }),
      replace: true,
    });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('developer.title')}
        description={t('developer.description')}
        actions={
          <Button asChild variant="secondary">
            <a href={`${GATEWAY_ORIGIN}/docs`} target="_blank" rel="noreferrer">
              {t('developer.apiReference')}
              <ExternalLinkIcon aria-hidden="true" />
              <span className="sr-only">{t('developer.newTab')}</span>
            </a>
          </Button>
        }
      />
      {tabs.length === 0 ? (
        <Forbidden />
      ) : (
        <Tabs value={tab} onValueChange={select}>
          <TabsList variant="line" className="h-auto flex-wrap justify-start">
            {tabs.map((value) => (
              <TabsTrigger key={value} value={value} className={TAB} data-testid={`tab-${value}`}>
                {t(`developer.tabs.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="keys" className="pt-4">
            <ApiKeysTab />
          </TabsContent>
          <TabsContent value="webhooks" className="pt-4">
            <WebhooksTab />
          </TabsContent>
          <TabsContent value="events" className="pt-4">
            <EventLogTab />
          </TabsContent>
          <TabsContent value="hosts" className="pt-4">
            <AllowedHostsTab />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
