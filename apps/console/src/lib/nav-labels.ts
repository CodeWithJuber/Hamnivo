import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { NavGroupId, NavPath } from './nav';
import type { ExtraPath } from './palette';

export interface NavLabels {
  groups: Record<NavGroupId, string>;
  pages: Record<NavPath, string>;
  /** Pages reached from a button rather than the menu, named as that button is. */
  extras: Record<ExtraPath, string>;
}

/**
 * What the menu calls each entry and each page. The menu, the row of links above a page and the
 * command palette all use these, so a page has one name everywhere.
 */
export function navLabels(t: TFunction): NavLabels {
  return {
    groups: {
      home: t('nav.home'),
      inbox: t('nav.inbox'),
      ai: t('nav.ai'),
      sales: t('nav.sales'),
      reports: t('reports.nav'),
      settings: t('nav.settings'),
    },
    pages: {
      '/overview': t('nav.home'),
      '/inbox': t('nav.inbox'),
      '/agents': t('nav.agents'),
      '/knowledge': t('nav.knowledge'),
      '/memory': t('nav.memory'),
      '/tools': t('tools.nav'),
      '/checks': t('checks.nav'),
      '/decisions': t('decisions.nav'),
      '/runs': t('nav.runs'),
      '/caching': t('caching.nav'),
      '/models': t('nav.models'),
      '/orders': t('commerce.nav.orders'),
      '/finance': t('commerce.nav.finance'),
      '/reports': t('reports.nav'),
      '/brands': t('nav.brands'),
      '/chat-widget': t('chatWidget.nav'),
      '/channels': t('channels.nav'),
      '/automations': t('automations.nav'),
      '/hours': t('setup.hours.nav'),
      '/team': t('nav.team'),
      '/support-teams': t('setup.teams.nav'),
      '/security': t('nav.security'),
      '/developer': t('developer.nav'),
      '/customer-identity': t('setup.identity.nav'),
      '/migration': t('migration.nav'),
      '/settings/billing': t('billing.nav'),
    },
    extras: {
      '/onboarding': t('setup.home.guided'),
      '/visitors': t('inboxAlerts.live.link'),
      '/saved-replies': t('inboxAlerts.library.link'),
      '/blocked': t('inbox.blocking.page.title'),
      '/stop-ai': t('shell.stopAi'),
      '/account': t('nav.account'),
      '/tenants': t('nav.switchWorkspace'),
    },
  };
}

/** The labels in the person's language. */
export function useNavLabels(): NavLabels {
  const { t } = useTranslation();
  return navLabels(t);
}
