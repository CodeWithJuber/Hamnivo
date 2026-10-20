import { Button } from '@hamnivo/ui/components/button';
import { HamnivoMark } from '@hamnivo/ui/components/hamnivo-mark';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@hamnivo/ui/components/sheet';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter, useRouterState } from '@tanstack/react-router';
import {
  BarChart3Icon,
  BotIcon,
  BuildingIcon,
  HouseIcon,
  InboxIcon,
  LogOutIcon,
  MenuIcon,
  OctagonPauseIcon,
  PlugIcon,
  ServerCogIcon,
  SettingsIcon,
  ShieldCheckIcon,
  WorkflowIcon,
  XIcon,
} from 'lucide-react';
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { directionOf, isLocale } from '../i18n';
import { useAgency } from '../lib/agency';
import { api } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { returnFocus, useOpener } from '../lib/focus';
import { formatDateTime } from '../lib/format';
import { killSwitchScope, useNames } from '../lib/names';
import {
  currentRoute,
  groupIdOfPath,
  menuFor,
  type NavGroupId,
  type NavPath,
  sectionOf,
} from '../lib/nav';
import { useNavLabels } from '../lib/nav-labels';
import { useKillSwitches } from '../lib/queries';
import { reauth } from '../lib/reauth';
import { chooseTenant, useTenant } from '../lib/tenant';
import type { PlatformOperator } from '../lib/types';
import { CommandPalette } from './CommandPalette';
import { LanguageSelect, TranslationNote } from './LanguageSelect';
import { PortalBrand } from './PortalBrand';
import { type SectionTab, SectionTabs } from './SectionTabs';
import { SuspendedNotice } from './SuspendedNotice';
import { WorkspaceNotices } from './WorkspaceNotices';

type NavIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

const GROUP_ICONS: Record<NavGroupId, NavIcon> = {
  home: HouseIcon,
  inbox: InboxIcon,
  ai: BotIcon,
  workflows: WorkflowIcon,
  connectors: PlugIcon,
  reports: BarChart3Icon,
  settings: SettingsIcon,
};

interface MenuEntry {
  id: NavGroupId;
  /** The first page of the group this person can see. */
  to: NavPath;
  label: string;
  icon: NavIcon;
  /** Any page of the group is being shown, nested ones included. */
  active: boolean;
}

interface MenuSection {
  label: string;
  tabs: SectionTab[];
}

/**
 * The menu for this person (see lib/nav.ts): up to seven entries, and for the group being shown the
 * pages they can open, as a row of links above the page.
 */
function useMenu(pathname: string): { entries: MenuEntry[]; section: MenuSection | null } {
  const { t } = useTranslation();
  const { can } = useTenant();
  const { groups: groupLabels, pages: pageLabels } = useNavLabels();

  const menu = menuFor(can);
  const activeId = groupIdOfPath(pathname);
  const entries = menu.map((group) => ({
    id: group.id,
    to: group.to,
    label: groupLabels[group.id],
    icon: GROUP_ICONS[group.id],
    active: group.id === activeId,
  }));
  const group = sectionOf(menu, pathname);
  const current = group ? currentRoute(group, pathname) : undefined;
  const section = group
    ? {
        label: t('nav.sections', { name: groupLabels[group.id] }),
        tabs: group.routes.map((route) => ({
          to: route.to,
          advanced: route.advanced,
          label: pageLabels[route.to],
          current: route.to === current,
        })),
      }
    : null;
  return { entries, section };
}

function NavLinks({
  entries,
  onNavigate,
}: {
  entries: readonly MenuEntry[];
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {entries.map((entry) => (
        <li key={entry.id}>
          <Link
            to={entry.to}
            onClick={onNavigate}
            aria-current={entry.active ? 'page' : undefined}
            data-status={entry.active ? 'active' : undefined}
            className="relative flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-sunken hover:text-text data-[status=active]:bg-surface-sunken data-[status=active]:text-text data-[status=active]:before:absolute data-[status=active]:before:inset-y-1.5 data-[status=active]:before:start-0 data-[status=active]:before:w-1 data-[status=active]:before:rounded-full data-[status=active]:before:bg-brand"
          >
            <entry.icon className="size-[18px] shrink-0" aria-hidden />
            <span>{entry.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { tenant } = useTenant();
  return (
    <Link
      to="/tenants"
      onClick={onNavigate}
      className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-start hover:bg-surface-sunken"
      aria-label={`${t('nav.switchWorkspace')}: ${tenant.name}`}
    >
      <BuildingIcon className="size-[18px] shrink-0 text-text-muted" aria-hidden="true" />
      <span className="flex min-w-0 flex-col">
        <span className="text-xs text-text-secondary">{t('nav.workspace')}</span>
        <span className="truncate text-sm font-medium text-text">
          <bdi>{tenant.name}</bdi>
        </span>
      </span>
    </Link>
  );
}

/** Whether this person is a platform operator (A17); the console itself checks again. */
function usePlatformOperator() {
  return useQuery({
    queryKey: ['platform', 'me'],
    queryFn: ({ signal }) => api<PlatformOperator>('/v1/platform/me', { signal }),
    retry: false,
    staleTime: 10 * 60_000,
  });
}

function AccountLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { me } = useTenant();
  const client = useQueryClient();
  const router = useRouter();
  const operator = usePlatformOperator();
  const signOut = async () => {
    reauth.pause();
    await authClient.signOut().catch(() => undefined);
    client.clear();
    chooseTenant(null);
    await router.navigate({ to: '/sign-in' });
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex min-w-0 flex-col px-3 text-sm">
        <span className="truncate font-medium text-text">
          <bdi>{me.user.name}</bdi>
        </span>
        <bdi dir="ltr" className="truncate text-xs text-text-secondary">
          {me.user.email}
        </bdi>
      </div>
      <Link
        to="/account"
        onClick={onNavigate}
        className="flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-sunken hover:text-text data-[status=active]:bg-surface-sunken data-[status=active]:text-text"
      >
        <ShieldCheckIcon className="size-[18px]" aria-hidden="true" />
        {t('nav.account')}
      </Link>
      {operator.data ? (
        <Link
          to="/platform"
          onClick={onNavigate}
          data-testid="platform-link"
          className="flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-sunken hover:text-text"
        >
          <ServerCogIcon className="size-[18px]" aria-hidden="true" />
          {t('nav.platform')}
        </Link>
      ) : null}
      <Button variant="ghost" className="justify-start gap-3 px-3" onClick={signOut}>
        <LogOutIcon className="rtl:-scale-x-100" aria-hidden="true" />
        {t('nav.signOut')}
      </Button>
      <TranslationNote className="px-3 text-xs text-text-secondary" />
    </div>
  );
}

function AgencyContext() {
  const { t } = useTranslation();
  const agency = useAgency();
  if (!agency.data?.enabled) return null;
  return (
    <Link
      to="/agency"
      className="min-w-0 rounded-md border border-border px-3 py-2 text-sm text-link"
      data-testid="agency-context"
    >
      {agency.data.branding.displayName ? (
        <bdi>{agency.data.branding.displayName}</bdi>
      ) : (
        t('agentic.clients')
      )}
    </Link>
  );
}

function Brand() {
  return <PortalBrand />;
}

/** Active stops, prominent on every page, with where, why and since when (X08). */
function KillSwitchBanner() {
  const { t } = useTranslation();
  const switches = useKillSwitches();
  const names = useNames();
  // A tool switch stops one tool's actions, not replies: it is listed on the Stop AI page.
  const active = (switches.data?.items ?? []).filter((s) => s.active && s.scope !== 'tool');
  if (active.length === 0) return null;
  return (
    <section
      aria-labelledby="kill-banner-title"
      data-testid="kill-switch-banner"
      className="border-b border-danger/30 bg-danger-subtle px-4 py-3 sm:px-6 lg:px-8"
    >
      <div className="flex flex-wrap items-start gap-3">
        <OctagonPauseIcon className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="kill-banner-title" className="font-semibold text-danger">
            {t('shell.killBanner.title')}
          </h2>
          <ul className="flex flex-col gap-1 text-sm text-text">
            {active.map((item) => (
              <li key={item.id}>
                <span className="font-medium">{killSwitchScope(t, names, item)}</span>
                {' · '}
                <bdi>{t('shell.reason', { reason: item.reason })}</bdi>
                {' · '}
                <span className="text-text-secondary">
                  {t('shell.since', { time: formatDateTime(item.createdAt) })}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-text-secondary">{t('shell.killBanner.people')}</p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link to="/stop-ai">{t('shell.killBanner.review')}</Link>
        </Button>
      </div>
    </section>
  );
}

/**
 * Studio frame (board 03): a menu of seven entries, a header with the always-visible Stop AI
 * button, the active-stop banner and the page, with the pages of the current entry as a row of
 * links above it. On narrow screens the menu becomes a sheet.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { can } = useTenant();
  const switches = useKillSwitches();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpener = useOpener(menuOpen);
  // A link in the sheet was followed: once the sheet has closed, focus goes to the new page.
  const followed = useRef(false);
  const follow = () => {
    followed.current = true;
    setMenuOpen(false);
  };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const menu = useMenu(pathname);
  const shownPath = useRef(pathname);
  const activeCount = (switches.data?.items ?? []).filter(
    (s) => s.active && s.scope !== 'tool',
  ).length;
  const dir = directionOf(isLocale(i18n.language) ? i18n.language : 'en');

  // After in-app navigation, start at the new page's heading (screen readers hear its name).
  // The first page of a visit keeps the browser's own start, so the skip link comes first.
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    const frame = requestAnimationFrame(() => {
      document.getElementById('page-title')?.focus({ preventScroll: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  return (
    <div className="min-h-dvh bg-bg lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]" data-maskable>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[80] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-md"
      >
        {t('app.skipToContent')}
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col gap-4 overflow-y-auto border-e border-border bg-surface-muted p-4 lg:flex">
        <Brand />
        <WorkspaceSwitcher />
        <nav aria-label={t('nav.label')} className="flex-1">
          <NavLinks entries={menu.entries} />
        </nav>
        <AccountLinks />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex min-h-16 flex-wrap items-center gap-2 border-b border-border bg-bg/95 px-4 py-2 backdrop-blur sm:px-6 lg:px-8">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={t('nav.openMenu')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <MenuIcon aria-hidden="true" />
          </Button>
          <span className="lg:hidden">
            <HamnivoMark className="size-7" title="Hamnivo" />
          </span>
          <AgencyContext />
          {/* One row on a phone too (320 px, every language): there, Stop AI shows only its icon
              (its name stays "Stop AI replies"), the language is chosen in the menu sheet, and
              the "AI stopped" badge gives way to the banner right below the header. */}
          <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
            <CommandPalette />
            {activeCount > 0 ? (
              <Link
                to="/stop-ai"
                className="rounded-full max-sm:hidden"
                data-testid="ai-stopped-status"
              >
                <StatusBadge
                  tone="danger"
                  icon={<OctagonPauseIcon className="size-3.5" aria-hidden="true" />}
                >
                  {t('shell.aiStopped')}
                </StatusBadge>
              </Link>
            ) : null}
            {/* Only for people who can stop the AI: a red button that leads nowhere they can act is noise. */}
            {can('agents.publish') ? (
              <Button asChild variant="destructive-solid" size="sm">
                <Link
                  to="/stop-ai"
                  aria-label={t('shell.stopAiLabel')}
                  data-testid="stop-ai-button"
                >
                  <OctagonPauseIcon aria-hidden="true" />
                  <span className="max-sm:sr-only">{t('shell.stopAi')}</span>
                </Link>
              </Button>
            ) : null}
            <div className="max-sm:hidden">
              <LanguageSelect id="studio-language" />
            </div>
          </div>
        </header>
        <KillSwitchBanner />
        <SuspendedNotice />
        <WorkspaceNotices />
        <main
          id="main"
          tabIndex={-1}
          className="flex min-w-0 flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8"
        >
          {menu.section ? <SectionTabs {...menu.section} /> : null}
          {children}
        </main>
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side={dir === 'rtl' ? 'right' : 'left'}
          showCloseButton={false}
          className="w-[min(20rem,85vw)] gap-4 overflow-y-auto bg-surface-muted p-4"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // After following a link, focus goes to the new page's heading. The shell's own move
            // happens while the sheet still traps focus, so it is done here, once it has closed
            // (returnFocus without an opener: the heading).
            returnFocus(followed.current ? null : menuOpener.current);
            followed.current = false;
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <SheetTitle asChild>
              <span>
                <Brand />
              </span>
            </SheetTitle>
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('app.close')}>
                <XIcon aria-hidden="true" />
              </Button>
            </SheetClose>
          </div>
          <SheetDescription className="sr-only">{t('nav.menu')}</SheetDescription>
          <WorkspaceSwitcher onNavigate={follow} />
          <nav aria-label={t('nav.label')} className="flex-1">
            <NavLinks entries={menu.entries} onNavigate={follow} />
          </nav>
          {/* On a phone the header has no room for it. */}
          <div className="px-3 sm:hidden">
            <LanguageSelect id="studio-language-menu" />
          </div>
          <AccountLinks onNavigate={follow} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
