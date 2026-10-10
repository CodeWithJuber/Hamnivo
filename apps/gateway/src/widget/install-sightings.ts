/**
 * Where a brand's chat code is running (HNV-01-04). The loader on a website asks for the chat's
 * launcher on every page; when that page is on one of the brand's allowed websites, the gateway
 * notes the website and the time. Nothing about the visitor is kept. Studio reads these to say
 * "found on https://shop.example, 3 minutes ago" instead of asking the owner to check by hand.
 */
import { schema, type TenantTx } from '@hamnivo/db';

/** How often one website's sighting is written, per gateway process. */
export const SIGHTING_INTERVAL_MS = 5 * 60_000;

/** Above this many remembered websites the memory starts over (a few extra writes, no harm). */
const MAX_REMEMBERED = 10_000;

/**
 * Whether a sighting is due: once per brand and website every interval in this process, so a
 * busy website costs one small write every few minutes, not one per page view.
 */
export class SightingThrottle {
  private readonly last = new Map<string, number>();

  constructor(private readonly intervalMs = SIGHTING_INTERVAL_MS) {}

  due(brandId: string, origin: string, now: number): boolean {
    const key = `${brandId} ${origin}`;
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < this.intervalMs) return false;
    if (this.last.size >= MAX_REMEMBERED) this.last.clear();
    this.last.set(key, now);
    return true;
  }

  /** After a failed write: the next page from that website tries again. */
  forget(brandId: string, origin: string): void {
    this.last.delete(`${brandId} ${origin}`);
  }
}

/**
 * The website a sighting is for: the page's origin, only when it is exactly one of the brand's
 * allowed websites. Local development pages (allowed while a brand has no websites) and Studio's
 * own test chat are not the brand's website, so they never count as the chat being installed.
 */
export function sightedOrigin(
  allowed: readonly string[],
  origin: string | undefined,
): string | undefined {
  if (!origin) return undefined;
  try {
    const normalized = new URL(origin).origin;
    return allowed.includes(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** Notes that the brand's chat ran on `origin` at `at`: the first time, or once more. */
export async function recordSighting(
  tx: TenantTx,
  row: { tenantId: string; brandId: string; origin: string; at: Date },
): Promise<void> {
  const table = schema.brandInstallSightings;
  await tx
    .insert(table)
    .values({
      tenantId: row.tenantId,
      brandId: row.brandId,
      origin: row.origin,
      firstSeenAt: row.at,
      lastSeenAt: row.at,
    })
    .onConflictDoUpdate({
      target: [table.tenantId, table.brandId, table.origin],
      set: { lastSeenAt: row.at },
    });
}
