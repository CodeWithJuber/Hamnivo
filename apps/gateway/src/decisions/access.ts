import { fromPublicId, schema, type TenantTx } from '@hamnivo/db';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';

export type BrandRow = typeof schema.brands.$inferSelect;

/** A public id of the given kind as a UUID, or NOT_FOUND (never a hint that it exists). */
export function idOf(kind: Parameters<typeof fromPublicId>[0], publicId: string, what: string) {
  try {
    return fromPublicId(kind, publicId);
  } catch {
    throw new AppError('NOT_FOUND', { detail: `${what} not found.` });
  }
}

/** The brand, if it exists in the tenant and the person holds `permission` for it. */
export async function authorizedBrand(
  tx: TenantTx,
  principal: StaffPrincipal,
  brandPublicId: string,
  permission: Permission,
  options: { now: Date; config: AppConfig },
): Promise<BrandRow> {
  const brandId = idOf('brand', brandPublicId, 'Brand');
  return authorizedBrandById(tx, principal, brandId, permission, options);
}

export async function authorizedBrandById(
  tx: TenantTx,
  principal: StaffPrincipal,
  brandId: string,
  permission: Permission,
  options: { now: Date; config: AppConfig },
): Promise<BrandRow> {
  const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
  if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
  enforce(
    authorize(
      principal,
      permission,
      { workspaceId: brand.workspaceId, brandId: brand.id },
      { now: options.now, stepUpMaxAgeMs: options.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
    ),
  );
  return brand;
}
