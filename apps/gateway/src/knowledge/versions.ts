import { createHash } from 'node:crypto';
import { schema, type TenantTx } from '@hamnivo/db';
import { desc, eq } from 'drizzle-orm';
import { enqueueOutbox } from '../outbox/outbox.js';

export type VersionRow = typeof schema.documentVersions.$inferSelect;

/**
 * Stores a new version of a document in quarantine and queues its ingestion (G17): the worker
 * scans it, reads its text, cuts it into passages and indexes them. The version before it keeps
 * answering until this one is ready. Used for what staff upload and for the pages of a website.
 */
export async function queueVersionIn(
  tx: TenantTx,
  tenantId: string,
  document: { id: string },
  input: { mediaType: string; bytes: Buffer; validUntil?: Date | null },
  createdBy: string | null,
): Promise<VersionRow> {
  const [latest] = await tx
    .select({ version: schema.documentVersions.version })
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.documentId, document.id))
    .orderBy(desc(schema.documentVersions.version))
    .limit(1);
  const [version] = await tx
    .insert(schema.documentVersions)
    .values({
      tenantId,
      documentId: document.id,
      version: (latest?.version ?? 0) + 1,
      mediaType: input.mediaType,
      byteSize: input.bytes.byteLength,
      contentHash: createHash('sha256').update(input.bytes).digest(),
      raw: input.bytes,
      validUntil: input.validUntil ?? null,
      createdBy,
    })
    .returning();
  if (!version) throw new Error('version insert returned nothing');
  await enqueueOutbox(tx, tenantId, {
    topic: 'knowledge.ingest',
    aggregateType: 'document_version',
    aggregateId: version.id,
    payload: { versionId: version.id },
  });
  return version;
}
