import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { NavFeatures } from './nav';
import type { Me, TenantSummary } from './types';

const STORAGE_KEY = 'hamnivo.studio.tenant';
let active: string | null | undefined;

/**
 * The tenant this tab works in. Read from the browser once per page load and then kept in
 * memory, so choosing another tenant in a second tab never switches this one mid-task.
 */
export function activeTenantId(): string | null {
  if (active === undefined) {
    try {
      active = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      active = null;
    }
  }
  return active;
}

/** Remembers the choice for this tab and as the default for new ones in this browser. */
export function chooseTenant(id: string | null): void {
  active = id;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked; the choice then lasts for this tab only.
  }
}

export interface TenantContextValue {
  tenantId: string;
  tenant: TenantSummary;
  me: Me;
  permissions: ReadonlySet<string>;
  can: (permission: string) => boolean;
  /** What the server switched on (`/v1/me` `features`); off when it says nothing. */
  features: NavFeatures;
}

const TenantContext = createContext<TenantContextValue | null>(null);

export function TenantProvider({
  me,
  tenant,
  children,
}: {
  me: Me;
  tenant: TenantSummary;
  children: ReactNode;
}) {
  const value = useMemo<TenantContextValue>(() => {
    const permissions = new Set(me.current?.permissions ?? []);
    return {
      tenantId: tenant.id,
      tenant,
      me,
      permissions,
      can: (permission) => permissions.has(permission),
      // A gateway older than this Studio, mid-deploy, sends no features: the frozen ones stay off.
      features: { advanced: me.features?.advanced === true },
    };
  }, [me, tenant]);
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const value = useContext(TenantContext);
  if (!value) throw new Error('useTenant must be used inside the Studio layout');
  return value;
}
