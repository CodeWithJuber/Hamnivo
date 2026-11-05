import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls } from './authority.js';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { modelConnections } from './runtime.js';
import { brands, tenantId } from './tenancy.js';

/**
 * What a business owner sets up from Studio alone: how a brand's chat looks and what it says, the
 * last test of each AI key, the conversations owners start themselves to try the chat, and where
 * the owner is in the setup wizard.
 */

/**
 * How a brand's chat looks and what it says (W03): colour, logo, corners, greeting, offline text,
 * rating and privacy link, as the `WidgetAppearance` contract (checked before it is stored). A
 * brand with no row, or a value that no longer parses, gets the contract's defaults.
 */
export const brandAppearance = pgTable(
  'brand_appearance',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    appearance: jsonb('appearance').$type<Record<string, unknown>>().notNull().default({}),
    draftAppearance: jsonb('draft_appearance').$type<Record<string, unknown>>(),
    draftRevision: integer('draft_revision').notNull().default(0),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('brand_appearance_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('brand_appearance_brand_key').on(t.tenantId, t.brandId),
    foreignKey({
      name: 'brand_appearance_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * Conversations started from a test chat in Studio. Reports, the inbox counts and the numbers on
 * Home leave them out; the conversation itself stays where it is, so a test of "talk to a person"
 * can be answered in the inbox.
 */
export const testConversations = pgTable(
  'test_conversations',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('test_conversations_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('test_conversations_conversation_key').on(t.tenantId, t.conversationId),
    foreignKey({
      name: 'test_conversations_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'test_conversations_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    tenantIsolation(),
  ],
);

/** The last test of each model connection's key: one row per connection, replaced by the next test. */
export const modelConnectionTests = pgTable(
  'model_connection_tests',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    ok: boolean('ok').notNull(),
    /** One of the `ModelProbeKind` results. */
    kind: text('kind').notNull(),
    modelId: text('model_id').notNull(),
    testedBy: uuid('tested_by'),
    testedAt: tstz('tested_at').notNull().defaultNow(),
  },
  (t) => [
    unique('model_connection_tests_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('model_connection_tests_connection_key').on(t.tenantId, t.connectionId),
    foreignKey({
      name: 'model_connection_tests_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [modelConnections.tenantId, modelConnections.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * Where the owner is in the setup wizard: the steps done or skipped, the brand it works on and
 * when it was finished. One row per tenant; what can be read from the data itself (a brand
 * exists, a key works) is read from there, not kept here.
 */
export const onboardingProgress = pgTable(
  'onboarding_progress',
  {
    id: id(),
    tenantId: tenantId(),
    /** Step name → `done` or `skipped` (the `OnboardingProgress` contract). */
    steps: jsonb('steps').$type<Record<string, string>>().notNull().default({}),
    brandId: uuid('brand_id'),
    finishedAt: tstz('finished_at'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('onboarding_progress_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('onboarding_progress_tenant_key').on(t.tenantId),
    index('onboarding_progress_brand_idx').on(t.tenantId, t.brandId),
    foreignKey({
      name: 'onboarding_progress_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * Where a brand's chat code was seen running (HNV-01-04): one row per brand and allowed website,
 * written when a page on that website asks for the chat's launcher. Only a website the brand
 * allows is recorded, and nothing about the visitor: the website, when it was first seen and
 * when last (updated at most every few minutes). A website taken off the brand's list loses its
 * row.
 */
export const brandInstallSightings = pgTable(
  'brand_install_sightings',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    origin: text('origin').notNull(),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    unique('brand_install_sightings_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('brand_install_sightings_origin_key').on(t.tenantId, t.brandId, t.origin),
    check('brand_install_sightings_origin_ck', sql`char_length(${t.origin}) between 1 and 300`),
    foreignKey({
      name: 'brand_install_sightings_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    tenantIsolation(),
  ],
);
