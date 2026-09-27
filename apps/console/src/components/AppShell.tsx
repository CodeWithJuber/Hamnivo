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
import { useQueryClient } from '@tanstack/react-query';
import { Link, useRouter, useRouterState } from '@tanstack/react-router';
import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  BuildingIcon,
  DatabaseZapIcon,
  InboxIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  OctagonPauseIcon,
  ShieldCheckIcon,
  StoreIcon,
  WaypointsIcon,
  XIcon,
} from 'lucide-react';
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { directionOf, isLocale } from '../i18n';
import { authClient } from '../lib/auth-client';
import { returnFocus, useOpener } from '../lib/focus';
import { formatDateTime } from '../lib/format';
import { killSwitchScope, useNames } from '../lib/names';
import { useKillSwitches } from '../lib/queries';
import { reauth } from '../lib/reauth';
import { chooseTenant, useTenant } from '../lib/tenant';
import { LanguageSelect, TranslationNote } from './LanguageSelect';
import { StopAiDialog } from './StopAiDialog';

type NavPath =
  | '/overview'
  | '/inbox'
  | '/brands'
  | '/agents'
  | '/knowledge'
  | '/memory'
  | '/models'
  | '/runs'
  | '/decisions'
  | '/caching'
  | '/stop-ai'
  | '/account';

interface NavItem {
  to: NavPath;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  permission?: string;
}

function useNavItems(): NavItem[] {
  const { t } = useTranslation();
  const { can } = useTenant();
  const items: NavItem[] = [
    { to: '/overview', label: t('nav.overview'), icon: LayoutDashboardIcon },
    {
      to: '/inbox',
      label: t('nav.inbox'),
      icon: InboxIcon,
      permission: 'conversations.read',
    },
    { to: '/brands', label: t('nav.brands'), icon: StoreIcon, permission: 'brands.manage' },
    { to: '/agents', label: t('nav.agents'), icon: BotIcon, permission: 'agents.read' },
    {
      to: '/knowledge',
      label: t('nav.knowledge'),
      icon: BookOpenIcon,
      permission: 'knowledge.read',
    },
    { to: '/memory', label: t('nav.memory'), icon: BrainIcon, permission: 'memory.read' },
    {
      to: '/models',
      label: t('nav.models'),
      icon: KeyRoundIcon,
      permission: 'integrations.manage',
    },
    { to: '/runs', label: t('nav.runs'), icon: ActivityIcon, permission: 'analytics.read' },
    {
      to: '/decisions',
      label: t('decisions.nav'),
      icon: WaypointsIcon,
      permission: 'decisions.read',
    },
    {
      to: '/caching',
      label: t('caching.nav'),
      icon: DatabaseZapIcon,
      permission: 'knowledge.read',
    },
    { to: '/stop-ai', label: t('nav.stopAi'), icon: OctagonPauseIcon, permission: 'agents.read' },
  ];
  // Navigation is filtered by role; the gateway still checks every request (HNV-03-05).
  return items.filter((item) => !item.permission || can(item.permission));
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const items = useNavItems();
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.to}>
          <Link
            to={item.to}
            onClick={onNavigate}
            className="relative flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-sunken hover:text-text data-[status=active]:bg-surface-sunken data-[status=active]:text-text data-[status=active]:before:absolute data-[status=active]:before:inset-y-1.5 data-[status=active]:before:start-0 data-[status=active]:before:w-1 data-[status=active]:before:rounded-full data-[status=active]:before:bg-brand"
          >
            <item.icon className="size-[18px] shrink-0" aria-hidden />
            <span>{item.label}</span>
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

function AccountLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { me } = useTenant();
  const client = useQueryClient();
  const router = useRouter();
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
      <Button variant="ghost" className="justify-start gap-3 px-3" onClick={signOut}>
        <LogOutIcon className="rtl:-scale-x-100" aria-hidden="true" />
        {t('nav.signOut')}
      </Button>
      <TranslationNote className="px-3 text-xs text-text-secondary" />
    </div>
  );
}

function Brand() {
  return (
    <span className="flex items-center gap-2">
      <HamnivoMark className="size-7" />
      <span className="text-lg font-semibold text-text">Hamnivo</span>
      <span className="text-sm text-text-secondary">Studio</span>
    </span>
  );
}

/** Active stops, prominent on every page, with where, why and since when (X08). */
function KillSwitchBanner() {
  const { t } = useTranslation();
  const switches = useKillSwitches();
  const names = useNames();
  const active = (switches.data?.items ?? []).filter((s) => s.active);
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
 * Studio frame (board 03): navigation rail, a header with the always-visible Stop AI control, the
 * active-stop banner and the page. On narrow screens the rail becomes a menu sheet.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { can } = useTenant();
  const switches = useKillSwitches();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpener = useOpener(menuOpen);
  const [stopOpen, setStopOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const shownPath = useRef(pathname);
  const activeCount = (switches.data?.items ?? []).filter((s) => s.active).length;
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
          <NavLinks />
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
          <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
            {activeCount > 0 ? (
              <Link to="/stop-ai" className="rounded-full" data-testid="ai-stopped-status">
                <StatusBadge
                  tone="danger"
                  icon={<OctagonPauseIcon className="size-3.5" aria-hidden="true" />}
                >
                  {t('shell.aiStopped')}
                </StatusBadge>
              </Link>
            ) : null}
            {can('agents.publish') ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setStopOpen(true)}
                aria-label={t('shell.stopAiLabel')}
                data-testid="stop-ai-button"
              >
                <OctagonPauseIcon aria-hidden="true" />
                {t('shell.stopAi')}
              </Button>
            ) : null}
            <LanguageSelect id="studio-language" />
          </div>
        </header>
        <KillSwitchBanner />
        <main
          id="main"
          tabIndex={-1}
          className="flex min-w-0 flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8"
        >
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
            // After following a link, the new page's heading already has focus.
            if (document.activeElement === document.body) returnFocus(menuOpener.current);
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
          <WorkspaceSwitcher onNavigate={() => setMenuOpen(false)} />
          <nav aria-label={t('nav.label')} className="flex-1">
            <NavLinks onNavigate={() => setMenuOpen(false)} />
          </nav>
          <AccountLinks onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>

      {can('agents.publish') ? <StopAiDialog open={stopOpen} onOpenChange={setStopOpen} /> : null}
    </div>
  );
}
