import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@hamnivo/ui/components/tabs';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandPicker, useChosenBrand } from '../../components/BrandPicker';
import { GuideLink } from '../../components/GuideLink';
import { PageHeader } from '../../components/PageHeader';
import { Forbidden, QueryState } from '../../components/States';
import { DOCS } from '../../lib/docs';
import type { BrandRef } from '../../lib/names';
import { useBrands } from '../../lib/queries';
import { useAppearance } from '../../lib/setup';
import { useTenant } from '../../lib/tenant';
import {
  CHAT_WIDGET_TABS,
  type ChatWidgetSearch,
  type ChatWidgetTab,
} from '../../routes/_studio/chat-widget';
import { SettingsForm, useWidgetSettings } from '../BrandChatSettings';
import { AppearanceForm } from '../settings/AppearanceDialog';
import { LeaveGuard } from '../settings/DiscardChangesDialog';
import { FormsTab } from './FormsTab';
import { PrivacyTab } from './PrivacyTab';
import { ShareTab } from './ShareTab';

const TAB = 'text-text-secondary hover:text-text data-[state=active]:text-text';

/** How the chat looks (W03): colour, logo, corners, greeting, offline text, rating, privacy link. */
function LookTab({ brand }: { brand: BrandRef }) {
  const { t } = useTranslation();
  const appearance = useAppearance(brand.id);
  const brands = useBrands();
  const [dirty, setDirty] = useState(false);
  return (
    <div className="flex flex-col gap-4" data-testid="look-tab">
      <LeaveGuard dirty={dirty} />
      <p>
        <GuideLink href={DOCS.setup.widgetLook}>{t('chatWidget.guideLook')}</GuideLink>
      </p>
      <QueryState query={appearance} label={t('setup.appearance.loading')}>
        {(view) => (
          <AppearanceForm
            key={`${brand.id}-${view.configVersion}-${view.draftRevision ?? 0}`}
            brand={{
              ...brand,
              widgetId: brands.data?.items.find((item) => item.id === brand.id)?.widgetId,
            }}
            view={view}
            layout="page"
            onDirtyChange={setDirty}
          />
        )}
      </QueryState>
    </div>
  );
}

/** How the chat behaves (W02, W09, W17, W23, W25). */
function BehaviourTab({ brand }: { brand: BrandRef }) {
  const { t } = useTranslation();
  const settings = useWidgetSettings(brand.id);
  const appearance = useAppearance(brand.id);
  const [dirty, setDirty] = useState(false);
  return (
    <div className="flex flex-col gap-4" data-testid="behaviour-tab">
      <LeaveGuard dirty={dirty} />
      <QueryState query={settings} label={t('chatSettings.loading')}>
        {(view) => (
          <SettingsForm
            key={`${brand.id}-${view.configVersion}`}
            brand={brand}
            initial={view.settings}
            layout="page"
            appearance={appearance.data?.appearance}
            onDirtyChange={setDirty}
          />
        )}
      </QueryState>
    </div>
  );
}

/**
 * The chat widget of one brand (Settings): how it looks and behaves, what it asks before a chat
 * and while nobody can answer, consent before chatting, and the direct link to share. Each tab
 * saves on its own; the page asks before leaving a tab, a brand or the page with changes that are
 * not saved.
 */
export function ChatWidgetPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/chat-widget' });
  const navigate = useNavigate({ from: '/chat-widget' });
  const { brands, active, chosen } = useChosenBrand(search.brand);
  const tab: ChatWidgetTab = search.tab ?? 'look';
  const go = (next: Partial<ChatWidgetSearch>, replace = false) =>
    void navigate({
      search: (current: ChatWidgetSearch) =>
        Object.fromEntries(
          Object.entries({ ...current, ...next }).filter(([, value]) => value !== undefined),
        ) as ChatWidgetSearch,
      replace,
    });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('chatWidget.title')} description={t('chatWidget.description')} />
      <QueryState
        query={{
          data: brands.items,
          error: brands.error,
          isPending: brands.pending,
          isRefetching: brands.isRefetching,
          refetch: brands.refetch,
        }}
        label={t('chatWidget.loading')}
        permitted={can('widget.configure') && brands.permitted}
        forbidden={
          <Forbidden
            title={t('chatWidget.forbidden.title')}
            description={t('chatWidget.forbidden.description')}
          />
        }
        isEmpty={() => active.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('chatWidget.noBrands.title')}
            description={t('chatWidget.noBrands.description')}
            action={
              can('brands.manage') ? (
                <Button asChild>
                  <Link to="/brands">{t('chatWidget.noBrands.action')}</Link>
                </Button>
              ) : undefined
            }
          />
        }
      >
        {() =>
          chosen ? (
            <div className="flex flex-col gap-6" data-testid="chat-widget" data-brand={chosen.id}>
              <BrandPicker
                id="chat-widget-brand"
                label={t('chatWidget.brand')}
                brands={active}
                value={chosen.id}
                onChange={(brand) => go({ brand })}
              />
              <Tabs
                value={tab}
                onValueChange={(value) => go({ tab: value as ChatWidgetTab }, true)}
              >
                <TabsList
                  variant="line"
                  aria-label={t('chatWidget.tabs.label')}
                  className="h-auto flex-wrap justify-start"
                >
                  {CHAT_WIDGET_TABS.map((value) => (
                    <TabsTrigger
                      key={value}
                      value={value}
                      className={TAB}
                      data-testid={`tab-${value}`}
                    >
                      {t(`chatWidget.tabs.${value}`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value="look" className="pt-4">
                  <LookTab key={chosen.id} brand={chosen} />
                </TabsContent>
                <TabsContent value="behaviour" className="pt-4">
                  <BehaviourTab key={chosen.id} brand={chosen} />
                </TabsContent>
                <TabsContent value="forms" className="pt-4">
                  <FormsTab key={chosen.id} brand={chosen} />
                </TabsContent>
                <TabsContent value="privacy" className="pt-4">
                  <PrivacyTab key={chosen.id} brand={chosen} />
                </TabsContent>
                <TabsContent value="share" className="pt-4">
                  <ShareTab key={chosen.id} brand={chosen} />
                </TabsContent>
              </Tabs>
            </div>
          ) : null
        }
      </QueryState>
    </div>
  );
}
