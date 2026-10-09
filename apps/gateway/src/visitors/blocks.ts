import type { TenantTx } from '@hamnivo/db';
import { type SQL, sql } from 'drizzle-orm';

/**
 * Whether a customer is blocked from chatting with a brand (H20): a block on them, on a browser
 * linked to them, or on their signed-in account. Lifted and expired blocks do not count.
 */
export function blockedCondition(brandId: string, principalId: string, now: Date): SQL {
  return sql`exists (
    select 1 from visitor_blocks vb
    where vb.brand_id = ${brandId}::uuid
      and vb.lifted_at is null
      and (vb.expires_at is null or vb.expires_at > ${now})
      and (
        vb.principal_id = ${principalId}::uuid
        or vb.visitor_id in (select v.id from visitors v where v.principal_id = ${principalId}::uuid)
        or vb.external_subject = (
          select cp.external_subject from customer_principals cp where cp.id = ${principalId}::uuid
        )
      )
  )`;
}

export async function isBlocked(
  tx: TenantTx,
  brandId: string,
  principalId: string,
  now: Date,
): Promise<boolean> {
  const { rows } = await tx.execute<{ blocked: boolean }>(
    sql`select ${blockedCondition(brandId, principalId, now)} as blocked`,
  );
  return rows[0]?.blocked === true;
}

/** Whether a browser on the brand's website is blocked, by its own block or its customer's. */
export async function isVisitorBlocked(
  tx: TenantTx,
  brandId: string,
  visitorId: string,
  principalId: string | null,
  now: Date,
): Promise<boolean> {
  const { rows } = await tx.execute<{ blocked: boolean }>(sql`
    select exists (
      select 1 from visitor_blocks vb
      where vb.brand_id = ${brandId}::uuid
        and vb.lifted_at is null
        and (vb.expires_at is null or vb.expires_at > ${now})
        and vb.visitor_id = ${visitorId}::uuid
    ) ${principalId ? sql`or ${blockedCondition(brandId, principalId, now)}` : sql``} as blocked`);
  return rows[0]?.blocked === true;
}

/**
 * Widget requests a blocked customer may still make: reading; privacy choices (memory, email
 * preferences, consent, deleting their own message); their language; marking messages read;
 * signing in or out; and linking the browser, so the page-tracking notice still shows. Everything
 * else that writes (starting or continuing a chat, the contact form, reopening, files, ratings,
 * reactions, shopping and actions) is refused.
 */
const STILL_ALLOWED = [
  /^\/v1\/widget\/memory\//,
  /^\/v1\/widget\/notifications$/,
  /^\/v1\/widget\/consent$/,
  /^\/v1\/widget\/language$/,
  /^\/v1\/widget\/identity$/,
  /^\/v1\/widget\/sessions\/reset$/,
  /^\/v1\/widget\/visitors\/link$/,
  /^\/v1\/widget\/conversations\/[^/]+\/read$/,
  /^\/v1\/widget\/conversations\/[^/]+\/messages\/[^/]+\/delete$/,
];

export function refusedWhenBlocked(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const bare = path.split('?')[0] ?? path;
  return !STILL_ALLOWED.some((pattern) => pattern.test(bare));
}
