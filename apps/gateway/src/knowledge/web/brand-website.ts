import { CreateWebSourceRequest } from '@hamnivo/contracts';
import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, count, eq, ne } from 'drizzle-orm';
import { normalizePageUrl } from './urls.js';

/** Websites one workspace keeps (the same ceiling as adding one by hand). */
export const MAX_WEB_SOURCES = 20;

/** Names reserved for examples and tests, never a business's real website (RFC 2606, 6761). */
const RESERVED = /\.(example|test|invalid|localhost|local)$/i;

/**
 * The brand's own public website among its allowed websites: HTTPS with a real host name. A
 * development address (localhost, an IP address, a reserved name) is no website to read.
 */
export function brandWebsite(origins: readonly string[]): string | null {
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    const host = url.hostname;
    if (url.protocol !== 'https:') continue;
    if (!host.includes('.') || RESERVED.test(host)) continue;
    if (/^[\d.]+$/.test(host) || host.startsWith('[')) continue;
    const start = normalizePageUrl(`${url.origin}/`);
    if (start) return start;
  }
  return null;
}

/**
 * Teaches the brand's AI its website without setup: when a brand has a public website and no
 * website knowledge yet, the website is added as a public source and read by the crawler (it
 * honours robots.txt and the workspace's egress rules, as for one added by hand). Making the
 * assistant live attaches it. Nothing is added past the workspace's limit, or a second time.
 */
export async function readBrandWebsite(
  tx: TenantTx,
  brand: { id: string; tenantId: string; workspaceId: string; allowedOrigins: string[] },
  actor: { staffId: string | null },
  now: Date,
): Promise<boolean> {
  const url = brandWebsite(brand.allowedOrigins);
  if (!url) return false;
  const live = ne(schema.knowledgeSources.status, 'retired');
  const [mine] = await tx
    .select({ id: schema.knowledgeWebSources.id })
    .from(schema.knowledgeWebSources)
    .innerJoin(
      schema.knowledgeSources,
      eq(schema.knowledgeSources.id, schema.knowledgeWebSources.sourceId),
    )
    .where(and(live, eq(schema.knowledgeSources.brandId, brand.id)))
    .limit(1);
  if (mine) return false;
  const [total] = await tx
    .select({ n: count() })
    .from(schema.knowledgeWebSources)
    .innerJoin(
      schema.knowledgeSources,
      eq(schema.knowledgeSources.id, schema.knowledgeWebSources.sourceId),
    )
    .where(live);
  if (Number(total?.n ?? 0) >= MAX_WEB_SOURCES) return false;
  const defaults = CreateWebSourceRequest.parse({
    brandId: toPublicId('brand', brand.id),
    url,
  });
  const [source] = await tx
    .insert(schema.knowledgeSources)
    .values({
      tenantId: brand.tenantId,
      workspaceId: brand.workspaceId,
      brandId: brand.id,
      name: new URL(url).hostname,
      visibility: defaults.visibility,
      ownerStaffId: actor.staffId,
    })
    .returning();
  if (!source) return false;
  const [web] = await tx
    .insert(schema.knowledgeWebSources)
    .values({
      tenantId: brand.tenantId,
      sourceId: source.id,
      startUrl: url,
      mode: defaults.mode,
      maxPages: defaults.maxPages,
      maxDepth: defaults.maxDepth,
      schedule: defaults.schedule,
      // Read as soon as the worker looks.
      state: 'queued',
      leaseUntil: now,
      createdBy: actor.staffId,
    })
    .returning();
  if (!web) return false;
  await appendAudit(tx, {
    actorType: actor.staffId ? 'staff' : 'system',
    actorId: actor.staffId ? toPublicId('staff', actor.staffId) : 'hamnivo',
    action: 'knowledge.web_source_added',
    targetType: 'knowledge_web_source',
    targetId: toPublicId('webSource', web.id),
    outcome: 'success',
    data: {
      url,
      mode: web.mode,
      maxPages: web.maxPages,
      maxDepth: web.maxDepth,
      schedule: web.schedule,
      visibility: source.visibility,
      automatic: true,
    },
  });
  return true;
}
