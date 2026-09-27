import { type ClaimedOutboxEvent, type Db, schema, withTenant } from '@hamnivo/db';
import { memorySlot } from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { pgErrorInfo } from '../common/pg-error.js';
import { EmbeddingFactory } from '../knowledge/embeddings.js';
import { APP_DB } from '../tokens.js';
import { memoryValue } from './views.js';

/**
 * Vectors for memory recall, computed by the worker (`memory.embed`) with the knowledge embedding
 * model. A vector is bound to the model and the content hash; it is dropped when its record is
 * superseded, outdated or deleted.
 */
@Injectable()
export class MemoryIndexService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly embeddings: EmbeddingFactory,
  ) {}

  async onEmbed(event: ClaimedOutboxEvent): Promise<void> {
    const { memoryId } = event.payload as { memoryId: string };
    const tenantId = event.tenantId;
    const [record] = await withTenant(this.db, { tenantId, actorId: 'system' }, (tx) =>
      tx.select().from(schema.memoryRecords).where(eq(schema.memoryRecords.id, memoryId)),
    );
    if (record?.status !== 'active') return;
    const label = memorySlot(record.key)?.label ?? record.key;
    const [vector] = await this.embeddings.embed([`${label}: ${memoryValue(record)}`]);
    if (!vector) return;
    try {
      await withTenant(this.db, { tenantId, actorId: 'system' }, (tx) =>
        tx
          .insert(schema.memoryEmbeddings)
          .values({
            tenantId,
            memoryId: record.id,
            subjectId: record.subjectId,
            embedding: vector,
            embeddingModel: this.embeddings.id,
            contentHash: record.contentHash,
          })
          .onConflictDoUpdate({
            target: [
              schema.memoryEmbeddings.tenantId,
              schema.memoryEmbeddings.memoryId,
              schema.memoryEmbeddings.embeddingModel,
            ],
            set: { embedding: vector, contentHash: record.contentHash },
          }),
      );
    } catch (error) {
      // Deleted while the vector was computed: nothing to index.
      if (pgErrorInfo(error).code === '23503') return;
      throw error;
    }
  }
}
