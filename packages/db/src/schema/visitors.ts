import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { customerPrincipals, staffMembers } from './identity.js';
import { brands, tenantId } from './tenancy.js';

/**
 * Website visitors (live visitors and the visitor card in the inbox). The chat loader on a brand's
 * website reports which page a visitor is on; nothing here holds an IP address, and every row
 * leaves the database 30 days after the visitor was last seen (`app.purge_visitors`).
 */

export const DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'other'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * A brand's visitor-tracking choices. A brand without a row tracks (the default), keeps no query
 * strings, and every visitor who sends Do Not Track is left out either way.
 */
export const brandVisitorSettings = pgTable(
  'brand_visitor_settings',
  {
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    /** Note which pages visitors view so staff can help in context. */
    tracking: boolean('tracking').notNull().default(true),
    /** Keep the part of a page address after "?" (off: it is removed before anything is stored). */
    keepQueryStrings: boolean('keep_query_strings').notNull().default(false),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'brand_visitor_settings_pkey', columns: [t.tenantId, t.brandId] }),
    foreignKey({
      name: 'brand_visitor_settings_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'brand_visitor_settings_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * One browser on a brand's website. The browser keeps a random key; only its SHA-256 is stored, so
 * a copy of the table cannot be used to act as a visitor. `principal_id` is set once that browser
 * opened the chat, which is how staff see the visitor's pages next to the conversation.
 */
export const visitors = pgTable(
  'visitors',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    keyHash: bytea('key_hash').notNull(),
    principalId: uuid('principal_id'),
    /** Visits so far (a visit ends after 30 minutes without a sign of life). */
    visitCount: integer('visit_count').notNull().default(1),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('visitors_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('visitors_key_key').on(t.tenantId, t.brandId, t.keyHash),
    index('visitors_seen_idx').on(t.tenantId, t.brandId, t.lastSeenAt),
    index('visitors_expiry_idx').on(t.lastSeenAt),
    index('visitors_principal_idx')
      .on(t.tenantId, t.principalId)
      .where(sql`${t.principalId} is not null`),
    foreignKey({
      name: 'visitors_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'visitors_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    check('visitors_count_ck', sql`${t.visitCount} >= 1`),
    tenantIsolation(),
  ],
);

/**
 * One visit: from the first page view until 30 minutes without a sign of life, or until the
 * visitor leaves. Device and browser are read from the User-Agent header and country from
 * Cloudflare's `CF-IPCountry` header; the IP address itself is never read.
 */
export const visitorSessions = pgTable(
  'visitor_sessions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    visitorId: uuid('visitor_id').notNull(),
    startedAt: tstz('started_at').notNull().defaultNow(),
    /** The latest sign of life, written at most once a minute while the page stays open. */
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    /** Set when the visitor closed the page. */
    endedAt: tstz('ended_at'),
    /** ISO 3166-1 alpha-2, or null when unknown. */
    country: text('country'),
    browser: text('browser'),
    browserVersion: text('browser_version'),
    os: text('os'),
    osVersion: text('os_version'),
    deviceType: text('device_type', { enum: DEVICE_TYPES }).notNull().default('other'),
    language: text('language'),
    /** Where the visitor came from, without a query string. */
    referrer: text('referrer'),
    entryUrl: text('entry_url').notNull(),
    currentUrl: text('current_url').notNull(),
    currentTitle: text('current_title'),
    pageCount: integer('page_count').notNull().default(0),
  },
  (t) => [
    unique('visitor_sessions_tenant_id_id_key').on(t.tenantId, t.id),
    index('visitor_sessions_live_idx')
      .on(t.tenantId, t.brandId, t.lastSeenAt)
      .where(sql`${t.endedAt} is null`),
    index('visitor_sessions_visitor_idx').on(t.tenantId, t.visitorId, t.startedAt),
    index('visitor_sessions_expiry_idx').on(t.startedAt),
    foreignKey({
      name: 'visitor_sessions_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'visitor_sessions_visitor_fk',
      columns: [t.tenantId, t.visitorId],
      foreignColumns: [visitors.tenantId, visitors.id],
    }).onDelete('cascade'),
    check('visitor_sessions_country_ck', sql`${t.country} is null or ${t.country} ~ '^[A-Z]{2}$'`),
    check(
      'visitor_sessions_device_ck',
      sql`${t.deviceType} in ('desktop', 'mobile', 'tablet', 'other')`,
    ),
    tenantIsolation(),
  ],
);

/** A page a visitor looked at. Addresses carry no query string unless the brand keeps them. */
export const visitorPageViews = pgTable(
  'visitor_page_views',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    visitorId: uuid('visitor_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    referrer: text('referrer'),
    viewedAt: tstz('viewed_at').notNull().defaultNow(),
  },
  (t) => [
    unique('visitor_page_views_tenant_id_id_key').on(t.tenantId, t.id),
    index('visitor_page_views_session_idx').on(t.tenantId, t.sessionId, t.viewedAt),
    index('visitor_page_views_expiry_idx').on(t.viewedAt),
    foreignKey({
      name: 'visitor_page_views_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'visitor_page_views_visitor_fk',
      columns: [t.tenantId, t.visitorId],
      foreignColumns: [visitors.tenantId, visitors.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'visitor_page_views_session_fk',
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [visitorSessions.tenantId, visitorSessions.id],
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);
