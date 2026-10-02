import { sql } from 'drizzle-orm';
import { foreignKey, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { customerPrincipals } from './identity.js';
import { tenantId } from './tenancy.js';

/**
 * A customer's language settings (U01, U10), kept separately: interface locale, the reply
 * language they chose, what was detected last, script, dialect, formality, style and time zone.
 * An explicit choice always wins over detection. Only language codes are stored, never messages.
 */
export const languagePreferences = pgTable(
  'language_preferences',
  {
    id: id(),
    tenantId: tenantId(),
    principalId: uuid('principal_id').notNull(),
    /** The widget's interface locale (en, ar, hi, ur). */
    uiLocale: text('ui_locale'),
    /** The reply language the customer chose (BCP 47), or null. */
    explicitLanguage: text('explicit_language'),
    /** The language of the latest replies and why it was chosen. */
    lastLanguage: text('last_language'),
    lastSource: text('last_source'),
    /** Candidate languages of the customer's latest message. */
    lastDetected: text('last_detected').array().notNull().default(sql`'{}'::text[]`),
    /** When the customer was asked to confirm an ambiguous language; they are asked only once. */
    promptedAt: tstz('prompted_at'),
    scriptPreference: text('script_preference'),
    dialect: text('dialect'),
    formality: text('formality'),
    styleVerbosity: text('style_verbosity', { enum: ['concise', 'conversational', 'formal'] }),
    styleTone: text('style_tone', { enum: ['gentle', 'direct'] }),
    timezone: text('timezone'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('language_preferences_tenant_id_id_key').on(t.tenantId, t.id),
    unique('language_preferences_principal_key').on(t.tenantId, t.principalId),
    foreignKey({
      name: 'language_preferences_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);
