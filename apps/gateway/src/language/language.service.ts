import type { SetWidgetLanguageRequest, WidgetLanguageState } from '@hamnivo/contracts';
import { type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import {
  type CommunicationStyle,
  detectLanguage,
  isReplyLanguage,
  isUiLocale,
  type LanguageDetection,
  type LanguageResolution,
  type LanguageSlice,
  type ReplyLanguage,
  resolveReplyLanguage,
  SLICE_OF_LANGUAGE,
  type UiLocale,
} from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import type { WidgetClaims } from '../widget/tokens.service.js';

type PreferenceRow = typeof schema.languagePreferences.$inferSelect;

export interface ReplyLanguageChoice {
  resolution: LanguageResolution;
  detection: LanguageDetection;
  style: CommunicationStyle;
}

const replyLanguage = (value: string | null | undefined): ReplyLanguage | null =>
  isReplyLanguage(value) ? value : null;
const uiLocale = (value: string | null | undefined): UiLocale | null =>
  isUiLocale(value) ? value : null;

/** The detection stored for the latest message: candidates only, never the text. */
function storedDetection(row: PreferenceRow | undefined): LanguageDetection | null {
  if (!row || row.lastDetected.length === 0) return null;
  const candidates = row.lastDetected.filter(isReplyLanguage);
  return {
    language: candidates.length === 1 ? (candidates[0] ?? null) : null,
    candidates,
    script: null,
    ambiguous: candidates.length > 1,
  };
}

/**
 * Customer language preferences (U01, U02, U10). The interface locale, the explicit reply
 * language, the latest detection and the style are stored separately per customer principal.
 * Messages are read only to detect their language and are never stored here.
 */
@Injectable()
export class LanguageService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async row(tx: TenantTx, principalId: string): Promise<PreferenceRow | undefined> {
    const [row] = await tx
      .select()
      .from(schema.languagePreferences)
      .where(eq(schema.languagePreferences.principalId, principalId));
    return row;
  }

  /** The widget locale the customer started with, when no preference records one. */
  private async sessionLocale(tx: TenantTx, principalId: string): Promise<UiLocale | null> {
    const [principal] = await tx
      .select({ locale: schema.customerPrincipals.locale })
      .from(schema.customerPrincipals)
      .where(eq(schema.customerPrincipals.id, principalId));
    return uiLocale(principal?.locale);
  }

  private resolve(
    row: PreferenceRow | undefined,
    locale: UiLocale | null,
    detection?: LanguageDetection | null,
  ) {
    return resolveReplyLanguage({
      explicit: replyLanguage(row?.explicitLanguage),
      previous: replyLanguage(row?.lastLanguage),
      uiLocale: locale,
      detection: detection === undefined ? storedDetection(row) : detection,
      prompted: row?.promptedAt != null,
    });
  }

  private view(row: PreferenceRow | undefined, locale: UiLocale | null): WidgetLanguageState {
    const resolution = this.resolve(row, locale);
    return {
      uiLocale: locale,
      replyLanguage: resolution.language,
      source: resolution.source,
      confirm: resolution.confirm,
      style: { verbosity: row?.styleVerbosity ?? null, tone: row?.styleTone ?? null },
    };
  }

  private tx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      work,
    );
  }

  async state(claims: WidgetClaims): Promise<WidgetLanguageState> {
    return this.tx(claims, async (tx) => {
      const row = await this.row(tx, claims.principalId);
      return this.view(
        row,
        uiLocale(row?.uiLocale) ?? (await this.sessionLocale(tx, claims.principalId)),
      );
    });
  }

  /** The customer's own choices: reply language, interface locale, style, or "don't ask". */
  async update(
    claims: WidgetClaims,
    input: z.output<typeof SetWidgetLanguageRequest>,
  ): Promise<WidgetLanguageState> {
    return this.tx(claims, async (tx) => {
      const changes: Partial<typeof schema.languagePreferences.$inferInsert> = {
        updatedAt: this.clock(),
      };
      if (input.replyLanguage !== undefined) {
        changes.explicitLanguage = input.replyLanguage;
        // Choosing answers the language question.
        if (input.replyLanguage) changes.promptedAt = this.clock();
      }
      if (input.uiLocale) changes.uiLocale = input.uiLocale;
      if (input.dismissPrompt) changes.promptedAt = this.clock();
      if (input.style?.verbosity !== undefined) changes.styleVerbosity = input.style.verbosity;
      if (input.style?.tone !== undefined) changes.styleTone = input.style.tone;
      const [row] = await tx
        .insert(schema.languagePreferences)
        .values({ tenantId: claims.tenantId, principalId: claims.principalId, ...changes })
        .onConflictDoUpdate({
          target: [schema.languagePreferences.tenantId, schema.languagePreferences.principalId],
          set: changes,
        })
        .returning();
      return this.view(
        row,
        uiLocale(row?.uiLocale) ?? (await this.sessionLocale(tx, claims.principalId)),
      );
    });
  }

  /**
   * The language to reply in for a customer's latest words, remembered for the next reply. A
   * conversation without a known customer (another channel) is detected from the words alone.
   */
  async forReply(
    tenantId: string,
    principalId: string | null,
    text: string,
  ): Promise<ReplyLanguageChoice> {
    const detection = detectLanguage(text);
    if (!principalId) {
      return { resolution: resolveReplyLanguage({ detection }), detection, style: {} };
    }
    return withTenant(this.db, { tenantId, actorId: 'language' }, async (tx) => {
      const row = await this.row(tx, principalId);
      const locale = uiLocale(row?.uiLocale) ?? (await this.sessionLocale(tx, principalId));
      const resolution = this.resolve(row, locale, detection);
      const changes = {
        lastLanguage: resolution.language,
        lastSource: resolution.source,
        lastDetected: detection.candidates,
        updatedAt: this.clock(),
      };
      await tx
        .insert(schema.languagePreferences)
        .values({ tenantId, principalId, ...changes })
        .onConflictDoUpdate({
          target: [schema.languagePreferences.tenantId, schema.languagePreferences.principalId],
          set: changes,
        });
      return {
        resolution,
        detection,
        style: { verbosity: row?.styleVerbosity ?? null, tone: row?.styleTone ?? null },
      };
    });
  }

  /**
   * The language routing should serve, as a slice: the explicit choice, otherwise the words. When
   * the words fit several languages equally (Hinglish or Roman Urdu), the others are alternatives
   * a team may speak instead. Read only.
   */
  async forRouting(
    tx: TenantTx,
    principalId: string | null,
    text: string,
  ): Promise<{ slice: LanguageSlice; alternatives: LanguageSlice[] }> {
    const detection = detectLanguage(text);
    const row = principalId ? await this.row(tx, principalId) : undefined;
    const locale = principalId
      ? (uiLocale(row?.uiLocale) ?? (await this.sessionLocale(tx, principalId)))
      : null;
    const resolution = this.resolve(row, locale, detection);
    const alternatives =
      resolution.source === 'explicit'
        ? []
        : detection.candidates
            .filter((candidate) => candidate !== resolution.language)
            .map((candidate) => SLICE_OF_LANGUAGE[candidate]);
    return { slice: SLICE_OF_LANGUAGE[resolution.language], alternatives };
  }
}
