import type { KNOWLEDGE_MEDIA_TYPES } from '@hamnivo/contracts';
import { type ClaimedOutboxEvent, type Db, schema, type TenantTx, withTenant } from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { EmbeddingFactory } from './embeddings.js';
import { ExtractionError, extractDocumentText } from './extract.js';
import type { Scanner } from './scanner.js';
import { chunkText, sanitizeText } from './text.js';

export const SCANNER = Symbol('SCANNER');

type VersionRow = typeof schema.documentVersions.$inferSelect;

/** Embedding requests per call. */
const BATCH = 64;
/** Outbox attempts before an embedding outage fails the version. */
const EMBED_ATTEMPTS = 5;

/**
 * Knowledge ingestion (G17), run by the worker for `knowledge.ingest`:
 * quarantine → scan (fail closed) → parse within limits → sanitize → chunk → embed → index.
 * The previous version keeps answering until the new one is ready. The upload is cleared when
 * ingestion ends, whatever the outcome.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SCANNER) private readonly scanner: Scanner,
    private readonly embeddings: EmbeddingFactory,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'ingestion' }, work);
  }

  private async end(
    tenantId: string,
    versionId: string,
    state: 'failed' | 'rejected',
    error: string,
  ): Promise<void> {
    await this.tx(tenantId, (tx) =>
      tx
        .update(schema.documentVersions)
        .set({ state, error, raw: null, progress: { stage: state } })
        .where(eq(schema.documentVersions.id, versionId)),
    );
    this.logger.log(`version ${versionId} ${state}: ${error}`);
  }

  async onIngest(event: ClaimedOutboxEvent): Promise<void> {
    const { versionId } = event.payload as { versionId: string };
    const tenantId = event.tenantId;
    const version = await this.tx(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.documentVersions)
        .where(eq(schema.documentVersions.id, versionId));
      if (!row || (row.state !== 'queued' && row.state !== 'processing') || !row.raw) return null;
      await tx
        .update(schema.documentVersions)
        .set({ state: 'processing', progress: { stage: 'scanning' } })
        .where(eq(schema.documentVersions.id, versionId));
      return row;
    });
    if (!version?.raw) return;

    const verdict = await this.scanner.scan(version.raw);
    if (!verdict.clean) {
      await this.end(
        tenantId,
        versionId,
        'rejected',
        verdict.reason === 'malware'
          ? 'The file was refused because malware was found in it.'
          : 'The file was refused because it could not be scanned. Please upload it again later.',
      );
      return;
    }

    let text: string;
    try {
      text = sanitizeText(
        await extractDocumentText(
          version.raw,
          version.mediaType as (typeof KNOWLEDGE_MEDIA_TYPES)[number],
        ),
      );
    } catch (error) {
      if (!(error instanceof ExtractionError)) throw error;
      await this.end(
        tenantId,
        versionId,
        error.reason === 'type_mismatch' ? 'rejected' : 'failed',
        error.message,
      );
      return;
    }
    if (!text) {
      await this.end(tenantId, versionId, 'failed', 'No readable text was found in the document.');
      return;
    }

    const chunks = chunkText(text);
    const title = await this.tx(tenantId, async (tx) => {
      const [document] = await tx
        .select({ title: schema.knowledgeDocuments.title })
        .from(schema.knowledgeDocuments)
        .where(eq(schema.knowledgeDocuments.id, version.documentId));
      return document?.title ?? '';
    });
    let vectors: number[][];
    try {
      vectors = [];
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        vectors.push(
          ...(await this.embeddings.embed(batch.map((c) => `${c.heading ?? title}\n${c.text}`))),
        );
      }
    } catch (error) {
      if (event.attempts < EMBED_ATTEMPTS) throw error;
      await this.end(
        tenantId,
        versionId,
        'failed',
        'The document could not be indexed. Please try again.',
      );
      return;
    }

    await this.tx(tenantId, (tx) => this.index(tx, tenantId, version, text, chunks, vectors));
  }

  private async index(
    tx: TenantTx,
    tenantId: string,
    version: VersionRow,
    text: string,
    chunks: ReturnType<typeof chunkText>,
    vectors: number[][],
  ) {
    const [document] = await tx
      .select()
      .from(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.id, version.documentId))
      .for('update');
    if (!document) return;
    const now = this.clock();
    await tx.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.versionId, version.id));
    if (chunks.length > 0) {
      await tx.insert(schema.knowledgeChunks).values(
        chunks.map((chunk, i) => ({
          tenantId,
          versionId: version.id,
          documentId: document.id,
          sourceId: document.sourceId,
          seq: chunk.seq,
          // Text before the first section is about the document as a whole.
          heading: chunk.heading ?? document.title,
          text: chunk.text,
          tokens: chunk.tokens,
          embedding: vectors[i] ?? null,
          embeddingModel: this.embeddings.id,
        })),
      );
    }
    await tx
      .update(schema.documentVersions)
      .set({
        state: 'ready',
        text,
        raw: null,
        error: null,
        readyAt: now,
        progress: { stage: 'ready', chunks: chunks.length },
      })
      .where(eq(schema.documentVersions.id, version.id));
    // A newer version may have become current while this one was processing.
    const [current] = document.currentVersionId
      ? await tx
          .select({ version: schema.documentVersions.version })
          .from(schema.documentVersions)
          .where(eq(schema.documentVersions.id, document.currentVersionId))
      : [];
    if (current && current.version > version.version) {
      await tx
        .update(schema.documentVersions)
        .set({ state: 'superseded' })
        .where(eq(schema.documentVersions.id, version.id));
      await tx
        .delete(schema.knowledgeChunks)
        .where(eq(schema.knowledgeChunks.versionId, version.id));
      return;
    }
    await tx
      .update(schema.knowledgeDocuments)
      .set({ currentVersionId: version.id, updatedAt: now })
      .where(eq(schema.knowledgeDocuments.id, document.id));
    // Older versions stop answering; their passages are removed, their text stays for audit.
    const older = and(
      eq(schema.documentVersions.documentId, document.id),
      ne(schema.documentVersions.id, version.id),
      eq(schema.documentVersions.state, 'ready'),
    );
    const superseded = await tx
      .update(schema.documentVersions)
      .set({ state: 'superseded' })
      .where(older)
      .returning({ id: schema.documentVersions.id });
    for (const row of superseded) {
      await tx.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.versionId, row.id));
    }
  }
}
