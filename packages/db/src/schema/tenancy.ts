import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, id, platformRead, tenantIsolation, updatedAt } from './helpers.js';

export const TENANT_STATUSES = ['active', 'suspended', 'closing'] as const;

export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    slug: citext('slug').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: TENANT_STATUSES }).notNull().default('active'),
    region: text('region').notNull().default('default'),
    defaultLocale: text('default_locale').notNull().default('en'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tenants_slug_key').on(t.slug),
    check('tenants_status_ck', sql`${t.status} in ('active', 'suspended', 'closing')`),
    tenantIsolation('id'),
    platformRead(),
  ],
);

/** `tenant_id` column referencing tenants; every tenant-owned table starts with it. */
export const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);

export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    slug: citext('slug').notNull(),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('workspaces_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('workspaces_slug_key').on(t.tenantId, t.slug),
    tenantIsolation(),
    platformRead(),
  ],
);

export interface BrandTheme {
  accent?: string;
  onAccent?: string;
  radius?: number;
  launcherPosition?: 'bottom-right' | 'bottom-left';
  logoUrl?: string | null;
}

/** Mirrors BusinessHours in @hamnivo/contracts (validated there before it is stored). */
export interface BrandBusinessHours {
  timezone: string;
  weekly: Record<
    'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat',
    { open: string; close: string }[]
  >;
  closedDates: string[];
}

export const brands = pgTable(
  'brands',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    /** Public widget identifier embedded in the loader snippet (TypeID `wid_…`). */
    widgetPublicId: text('widget_public_id').notNull(),
    allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
    theme: jsonb('theme').$type<BrandTheme>().notNull().default({}),
    /** When people answer (W11); null means no hours are set. */
    businessHours: jsonb('business_hours').$type<BrandBusinessHours>(),
    configVersion: integer('config_version').notNull().default(1),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('brands_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('brands_widget_public_id_key').on(t.widgetPublicId),
    foreignKey({
      name: 'brands_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    tenantIsolation(),
    platformRead(),
  ],
);
