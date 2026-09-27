import { fromPublicId, schema, type TenantTx } from '@hamnivo/db';
import type { CommerceCapabilities, CommerceOperation } from '@hamnivo/domain/commerce';
import { negotiate } from '@hamnivo/domain/commerce';
import { authorize, type Decision, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { and, eq } from 'drizzle-orm';
import type { ControlRow } from '../authority/ownership.service.js';
import { AppError } from '../common/app-error.js';
import { enforce } from '../identity/staff.guard.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import type { MerchantRow } from './providers.service.js';

/** The customer's own conversation, or NOT_FOUND (never "forbidden", which would confirm it). */
export async function customerConversation(
  tx: TenantTx,
  claims: WidgetClaims,
  conversationPublicId: string,
): Promise<ControlRow> {
  const [control] = await tx
    .select()
    .from(schema.conversationControls)
    .where(
      and(
        eq(schema.conversationControls.id, fromPublicId('conversation', conversationPublicId)),
        eq(schema.conversationControls.principalId, claims.principalId),
      ),
    );
  if (!control) throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
  return control;
}

/** The brand's active merchant connection, if it sells in chat. */
export async function activeMerchant(
  tx: TenantTx,
  brandId: string | null,
): Promise<MerchantRow | null> {
  if (!brandId) return null;
  const [merchant] = await tx
    .select()
    .from(schema.merchantConnections)
    .where(
      and(
        eq(schema.merchantConnections.brandId, brandId),
        eq(schema.merchantConnections.status, 'active'),
      ),
    );
  return merchant ?? null;
}

export function requireMerchant(merchant: MerchantRow | null): MerchantRow {
  if (!merchant) {
    throw new AppError('FEATURE_DISABLED', {
      detail: 'Ordering in chat is not available for this shop.',
    });
  }
  return merchant;
}

/** Capability negotiation (E02): unsupported operations are refused with a recovery path. */
export function requireCapability(
  merchant: MerchantRow,
  operation: CommerceOperation,
  context: { currency?: string } = {},
): void {
  const result = negotiate(
    merchant.capabilities as unknown as CommerceCapabilities,
    operation,
    context,
  );
  if (result.supported) return;
  throw new AppError('CAPABILITY_UNSUPPORTED', {
    detail:
      result.reason === 'currency_not_supported'
        ? 'The shop does not sell in this currency.'
        : 'The shop does not support this in chat. Please contact the team.',
    internal: result,
  });
}

export interface BrandScope {
  brandId: string;
  workspaceId: string;
}

export async function brandScope(tx: TenantTx, brandId: string): Promise<BrandScope | null> {
  const [brand] = await tx
    .select({ id: schema.brands.id, workspaceId: schema.brands.workspaceId })
    .from(schema.brands)
    .where(eq(schema.brands.id, brandId));
  return brand ? { brandId: brand.id, workspaceId: brand.workspaceId } : null;
}

export function decide(
  principal: StaffPrincipal,
  permission: Permission,
  scope: BrandScope,
  options: { now: Date; stepUpMaxAgeMs: number },
): Decision {
  return authorize(
    principal,
    permission,
    { workspaceId: scope.workspaceId, brandId: scope.brandId },
    options,
  );
}

/**
 * Checks a staff permission against a brand. Outside the caller's scope the resource does not
 * exist for them; missing MFA or a stale sign-in asks for them instead.
 */
export function requireBrand(
  principal: StaffPrincipal,
  permission: Permission,
  scope: BrandScope | null,
  options: { now: Date; stepUpMaxAgeMs: number },
  notFound = 'Not found.',
): void {
  if (!scope) throw new AppError('NOT_FOUND', { detail: notFound });
  const decision = decide(principal, permission, scope, options);
  if (
    !decision.allowed &&
    decision.reason !== 'mfa_required' &&
    decision.reason !== 'step_up_required'
  ) {
    throw new AppError('NOT_FOUND', { detail: notFound });
  }
  enforce(decision);
}
