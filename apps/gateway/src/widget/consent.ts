import { type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { consentRequired } from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { APP_DB } from '../tokens.js';
import { type BrandSurface, brandSurface } from './settings.service.js';
import type { WidgetClaims } from './tokens.service.js';

/**
 * Consent before chatting (W27). Whether a visitor is asked depends on the brand's mode and, for
 * "EU, EEA and UK", on the country of the request, which is read each time and never stored. What
 * is kept is the customer's agreement: the version of the words and the time.
 */

/** The customer agreed to this version of the brand's words. */
export async function consentGiven(
  tx: TenantTx,
  principalId: string,
  noticeVersion: number,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.chatConsents.id })
    .from(schema.chatConsents)
    .where(
      and(
        eq(schema.chatConsents.principalId, principalId),
        eq(schema.chatConsents.noticeVersion, noticeVersion),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** What the widget needs to know about consent for this request. */
export async function consentState(
  tx: TenantTx,
  surface: Pick<BrandSurface, 'consent' | 'consentVersion'>,
  principalId: string,
  country: string | null,
): Promise<{ required: boolean; given: boolean }> {
  const required = consentRequired(surface.consent.mode, country);
  return {
    required,
    given: required && (await consentGiven(tx, principalId, surface.consentVersion)),
  };
}

/** Refuses to go on when this visitor must agree first and has not agreed to the current words. */
export async function assertConsent(
  tx: TenantTx,
  surface: Pick<BrandSurface, 'consent' | 'consentVersion'>,
  principalId: string,
  country: string | null,
): Promise<void> {
  const state = await consentState(tx, surface, principalId, country);
  if (state.required && !state.given) {
    throw new AppError('CONSENT_REQUIRED', {
      detail: 'Please agree to how this chat is kept before you start.',
    });
  }
}

/**
 * Records that the customer agreed to the brand's current words. Agreeing again to the same
 * version adds nothing; agreeing to words that have since changed is refused, so nobody is held to
 * words they did not see.
 */
export async function recordConsent(
  tx: TenantTx,
  input: {
    tenantId: string;
    brandId: string;
    principalId: string;
    noticeVersion: number;
    surface: Pick<BrandSurface, 'consent' | 'consentVersion'>;
  },
): Promise<void> {
  if (input.surface.consent.mode === 'off') return;
  if (input.noticeVersion !== input.surface.consentVersion) {
    throw new AppError('VERSION_CONFLICT', {
      detail: 'The words changed while you were reading them. Please read them again.',
    });
  }
  if (await consentGiven(tx, input.principalId, input.noticeVersion)) return;
  await tx.insert(schema.chatConsents).values({
    tenantId: input.tenantId,
    brandId: input.brandId,
    principalId: input.principalId,
    noticeVersion: input.noticeVersion,
  });
}

/** The widget's "I agree" (W27). */
@Injectable()
export class WidgetConsentService {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  async give(claims: WidgetClaims, noticeVersion: number): Promise<void> {
    await withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      async (tx) =>
        recordConsent(tx, {
          tenantId: claims.tenantId,
          brandId: claims.brandId,
          principalId: claims.principalId,
          noticeVersion,
          surface: await brandSurface(tx, claims.brandId),
        }),
    );
  }
}
