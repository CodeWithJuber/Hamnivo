import { createHash } from 'node:crypto';
import { safeRequest } from '@hamnivo/adapters/net';
import type { WebSyncResult, WebSyncSummary } from '@hamnivo/contracts';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { AppConfig } from '../../config.js';
import { EgressService } from '../../developer/egress.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../../tokens.js';
import { htmlText } from '../extract.js';
import { sanitizeText } from '../text.js';
import { queueVersionIn } from '../versions.js';
import { type CrawlReport, crawlSite, type PageOutcome, type SkipReason } from './crawler.js';
import { nextRunAfter, SKIP_TEXT, Tally } from './summary.js';
import { nameFromUrl } from './urls.js';
import type { WebPageRow, WebSourceRow } from './views.js';

type SourceRow = typeof schema.knowledgeSources.$inferSelect;
type PageValues = Partial<typeof schema.knowledgeWebPages.$inferInsert>;

const ACTOR = 'web-sync';
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A read that stops without finishing is picked up again after this long without a sign of life. */
const LEASE_MS = 5 * MINUTE;
/** One read never runs longer than this. */
const RUN_LIMIT_MS = 20 * MINUTE;
const REQUEST_TIMEOUT_MS = 30_000;
/** A page whose last version could not be indexed is offered to ingestion again after this long. */
const RETRY_INDEXING_AFTER_MS = 12 * HOUR;

/** Everything one read of a website keeps track of. */
interface Run {
  tenantId: string;
  web: WebSourceRow;
  source: SourceRow;
  tally: Tally;
  /** Addresses that got an outcome in this read. */
  seen: Set<string>;
  /** Text hashes of the pages kept so far, so a second address for one page is read once. */
  hashes: Map<string, string>;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest();

/** The text of a page as ingestion will read it; empty when there is none to read. */
function pageText(html: Buffer): string {
  try {
    return sanitizeText(htmlText(html.toString('utf8')));
  } catch {
    return '';
  }
}

/**
 * Reads a website kept as knowledge (G04, G17): runs the crawl, then makes each page a document of
 * the source. A new page becomes a document; a changed page becomes a new version of its document
 * (the old one keeps answering until the new one is indexed); an unchanged page costs nothing; a
 * page that is gone, or that the site now asks readers to leave alone, is retired. Every version
 * goes through the same quarantine, scan, extraction and indexing as an upload, and every request
 * goes through the egress guard under the tenant's own policy.
 */
@Injectable()
export class WebSyncService {
  private readonly logger = new Logger(WebSyncService.name);
  private halted = false;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly egress: EgressService,
  ) {}

  /** Stops the read in progress at its next page; what it has read so far is kept. */
  halt(): void {
    this.halted = true;
  }

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: ACTOR }, work);
  }

  /**
   * Takes the website for this worker: it must be due (scheduled, asked for, or left running by a
   * worker that stopped) and nobody else must hold it. Returns nothing when it is not for us.
   */
  private claim(tenantId: string, id: string) {
    return this.tx(tenantId, async (tx) => {
      const [web] = await tx
        .select()
        .from(schema.knowledgeWebSources)
        .where(eq(schema.knowledgeWebSources.id, id))
        .for('update');
      if (!web) return null;
      const now = this.clock();
      const leaseOver = !web.leaseUntil || web.leaseUntil <= now;
      const due =
        web.state === 'idle'
          ? web.schedule !== 'manual' && web.nextRunAt !== null && web.nextRunAt <= now
          : leaseOver;
      if (!due) return null;
      const [source] = await tx
        .select()
        .from(schema.knowledgeSources)
        .where(eq(schema.knowledgeSources.id, web.sourceId));
      if (source?.status !== 'active') {
        // Paused or retired: nothing is read, and it is looked at again tomorrow in case it was
        // switched back on.
        await tx
          .update(schema.knowledgeWebSources)
          .set({
            state: 'idle',
            leaseUntil: null,
            nextRunAt: web.schedule === 'manual' ? null : new Date(now.getTime() + DAY),
            updatedAt: now,
          })
          .where(eq(schema.knowledgeWebSources.id, web.id));
        return null;
      }
      await tx
        .update(schema.knowledgeWebSources)
        .set({ state: 'running', leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
        .where(eq(schema.knowledgeWebSources.id, web.id));
      return { web, source, startedAt: now };
    });
  }

  /** Reads one website now. Returns whether this call did (false: not due, or held elsewhere). */
  async run(tenantId: string, webSourceId: string): Promise<boolean> {
    if (this.halted) return false;
    const claimed = await this.claim(tenantId, webSourceId);
    if (!claimed) return false;
    const { web, source, startedAt } = claimed;
    const run: Run = {
      tenantId,
      web,
      source,
      tally: new Tally(),
      seen: new Set(),
      hashes: new Map(),
    };
    let report: CrawlReport | null = null;
    try {
      const policy = await this.tx(tenantId, (tx) => this.egress.policyIn(tx));
      const known = new Map(
        (
          await this.tx(tenantId, (tx) =>
            tx
              .select()
              .from(schema.knowledgeWebPages)
              .where(eq(schema.knowledgeWebPages.webSourceId, web.id)),
          )
        ).map((row) => [row.url, row]),
      );
      report = await crawlSite(
        { startUrl: web.startUrl, mode: web.mode, maxPages: web.maxPages, maxDepth: web.maxDepth },
        {
          request: (url, { headers, maxBytes }) =>
            safeRequest(
              { url, headers, timeoutMs: REQUEST_TIMEOUT_MS, maxResponseBytes: maxBytes },
              policy,
            ),
          known: (url) => {
            const row = known.get(url);
            return row?.documentId && !row.goneAt
              ? { etag: row.etag, lastModified: row.lastModified }
              : undefined;
          },
          onOutcome: (outcome) => this.outcome(run, outcome),
          delayMs: this.config.KNOWLEDGE_WEB_DELAY_MS,
          sleep: (ms) =>
            ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve(),
          now: () => (this.halted ? Number.MAX_SAFE_INTEGER : this.clock().getTime()),
          deadline: startedAt.getTime() + RUN_LIMIT_MS,
        },
      );
    } catch (error) {
      this.logger.warn(
        `website ${webSourceId} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      run.tally.failed += 1;
      run.tally.problem(web.startUrl, 'The read stopped unexpectedly. It will be tried again.');
    }
    await this.finish(run, report, startedAt);
    return true;
  }

  /** Records what one address came to; answers whether it is a page that was kept. */
  private outcome(run: Run, outcome: PageOutcome): Promise<boolean> {
    run.seen.add(outcome.url);
    return this.tx(run.tenantId, async (tx) => {
      const kept = await this.apply(tx, run, outcome);
      // The read is alive: nobody else takes it over.
      await tx
        .update(schema.knowledgeWebSources)
        .set({ leaseUntil: new Date(this.clock().getTime() + LEASE_MS) })
        .where(eq(schema.knowledgeWebSources.id, run.web.id));
      return kept;
    });
  }

  private apply(tx: TenantTx, run: Run, outcome: PageOutcome): Promise<boolean> {
    switch (outcome.kind) {
      case 'page':
        return this.keep(tx, run, outcome);
      case 'not_modified':
        return this.confirm(tx, run, outcome.url);
      case 'gone':
        return this.gone(tx, run, outcome.url, outcome.status, outcome.depth);
      case 'failed':
        return this.failed(tx, run, outcome);
      case 'skipped':
        return this.left(tx, run, outcome.url, outcome.reason);
    }
  }

  private async pageRow(tx: TenantTx, run: Run, url: string): Promise<WebPageRow | undefined> {
    const [row] = await tx
      .select()
      .from(schema.knowledgeWebPages)
      .where(
        and(
          eq(schema.knowledgeWebPages.webSourceId, run.web.id),
          eq(schema.knowledgeWebPages.url, url),
        ),
      )
      .for('update');
    return row;
  }

  private async savePage(
    tx: TenantTx,
    run: Run,
    existing: WebPageRow | undefined,
    url: string,
    values: PageValues,
  ): Promise<void> {
    if (existing) {
      await tx
        .update(schema.knowledgeWebPages)
        .set({ ...values, updatedAt: this.clock() })
        .where(eq(schema.knowledgeWebPages.id, existing.id));
      return;
    }
    await tx
      .insert(schema.knowledgeWebPages)
      .values({ ...values, tenantId: run.tenantId, webSourceId: run.web.id, url });
  }

  /** A page that was read: a new document, a new version, or nothing to do. */
  private async keep(
    tx: TenantTx,
    run: Run,
    page: Extract<PageOutcome, { kind: 'page' }>,
  ): Promise<boolean> {
    const now = this.clock();
    let hash: Buffer;
    if (page.mediaType === 'text/html') {
      const text = pageText(page.body);
      if (!text) return this.left(tx, run, page.url, 'empty');
      hash = sha256(text);
    } else {
      hash = sha256(page.body);
    }
    const key = hash.toString('hex');
    const twin = run.hashes.get(key);
    if (twin && twin !== page.url) return this.left(tx, run, page.url, 'duplicate');
    run.hashes.set(key, page.url);

    const existing = await this.pageRow(tx, run, page.url);
    const title = (page.title ?? nameFromUrl(page.url)).slice(0, 200);
    const seen: PageValues = {
      depth: page.depth,
      etag: page.etag,
      lastModified: page.lastModified,
      contentHash: hash,
      lastFetchedAt: now,
      lastStatus: page.status,
      lastError: null,
      failures: 0,
      goneAt: null,
    };
    const input = { mediaType: page.mediaType, bytes: page.body };

    if (existing?.documentId) {
      const [document] = await tx
        .select()
        .from(schema.knowledgeDocuments)
        .where(eq(schema.knowledgeDocuments.id, existing.documentId))
        .for('update');
      if (document) {
        const mine = existing.goneAt !== null;
        // A document someone retired by hand stays retired; only one that was retired because the
        // page was gone comes back when the page does.
        if (document.status === 'retired' && !mine) {
          await this.savePage(tx, run, existing, page.url, seen);
          run.tally.unchanged += 1;
          run.tally.kept += 1;
          return true;
        }
        const changed = !existing.contentHash?.equals(hash);
        const retry = !changed && (await this.indexingFailed(tx, document.id, now));
        if (changed || retry) await queueVersionIn(tx, run.tenantId, document, input, null);
        await tx
          .update(schema.knowledgeDocuments)
          .set({ title, url: page.url, status: 'active', reviewedAt: now, updatedAt: now })
          .where(eq(schema.knowledgeDocuments.id, document.id));
        await this.savePage(tx, run, existing, page.url, seen);
        if (changed || retry || document.status === 'retired') run.tally.updated += 1;
        else run.tally.unchanged += 1;
        run.tally.kept += 1;
        return true;
      }
    }

    const [document] = await tx
      .insert(schema.knowledgeDocuments)
      .values({
        tenantId: run.tenantId,
        sourceId: run.source.id,
        title,
        url: page.url,
        reviewedAt: now,
      })
      .returning();
    if (!document) throw new Error('document insert returned nothing');
    await queueVersionIn(tx, run.tenantId, document, input, null);
    await this.savePage(tx, run, existing, page.url, { ...seen, documentId: document.id });
    run.tally.added += 1;
    run.tally.kept += 1;
    return true;
  }

  /** Whether the document's latest version could not be indexed, long enough ago to try again. */
  private async indexingFailed(tx: TenantTx, documentId: string, now: Date): Promise<boolean> {
    const [latest] = await tx
      .select({
        state: schema.documentVersions.state,
        createdAt: schema.documentVersions.createdAt,
      })
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentId, documentId))
      .orderBy(desc(schema.documentVersions.version))
      .limit(1);
    return (
      latest?.state === 'failed' &&
      latest.createdAt.getTime() < now.getTime() - RETRY_INDEXING_AFTER_MS
    );
  }

  /** The site answered "not modified": the page is what it was, and was checked just now. */
  private async confirm(tx: TenantTx, run: Run, url: string): Promise<boolean> {
    const row = await this.pageRow(tx, run, url);
    if (!row?.documentId) return false;
    const now = this.clock();
    await this.savePage(tx, run, row, url, {
      lastFetchedAt: now,
      lastStatus: 304,
      lastError: null,
      failures: 0,
    });
    await tx
      .update(schema.knowledgeDocuments)
      .set({ reviewedAt: now })
      .where(
        and(
          eq(schema.knowledgeDocuments.id, row.documentId),
          eq(schema.knowledgeDocuments.status, 'active'),
        ),
      );
    run.tally.unchanged += 1;
    run.tally.kept += 1;
    return true;
  }

  /** The page is not there (404, 410): what was learned from it stops answering. */
  private async gone(
    tx: TenantTx,
    run: Run,
    url: string,
    status: number,
    depth: number,
  ): Promise<boolean> {
    const row = await this.pageRow(tx, run, url);
    const reason = 'The page is not there any more.';
    if (row && !row.goneAt) await this.retire(tx, run, row, reason, status);
    else {
      await this.savePage(tx, run, row, url, {
        depth,
        goneAt: this.clock(),
        lastFetchedAt: this.clock(),
        lastStatus: status,
        lastError: reason,
      });
    }
    return false;
  }

  /** The page could not be read this time (not a reason to forget what it said before). */
  private async failed(
    tx: TenantTx,
    run: Run,
    outcome: Extract<PageOutcome, { kind: 'failed' }>,
  ): Promise<boolean> {
    const row = await this.pageRow(tx, run, outcome.url);
    run.tally.failed += 1;
    run.tally.problem(outcome.url, outcome.reason);
    await this.savePage(tx, run, row, outcome.url, {
      depth: outcome.depth,
      lastFetchedAt: this.clock(),
      lastStatus: outcome.status,
      lastError: outcome.reason,
      failures: (row?.failures ?? 0) + 1,
    });
    return false;
  }

  /** The page was left out. If it was part of the source before, it is retired. */
  private async left(tx: TenantTx, run: Run, url: string, reason: SkipReason): Promise<boolean> {
    run.tally.skipped[reason] += 1;
    const row = await this.pageRow(tx, run, url);
    if (row?.documentId && !row.goneAt) await this.retire(tx, run, row, SKIP_TEXT[reason], null);
    // The address a person typed is the one they will ask about.
    if (url === run.web.startUrl && reason !== 'duplicate') {
      run.tally.problem(url, SKIP_TEXT[reason]);
    }
    return false;
  }

  private async retire(
    tx: TenantTx,
    run: Run,
    row: WebPageRow,
    reason: string,
    status: number | null,
  ): Promise<void> {
    const now = this.clock();
    if (row.documentId) {
      await tx
        .update(schema.knowledgeDocuments)
        .set({ status: 'retired', updatedAt: now })
        .where(
          and(
            eq(schema.knowledgeDocuments.id, row.documentId),
            eq(schema.knowledgeDocuments.status, 'active'),
          ),
        );
    }
    await this.savePage(tx, run, row, row.url, {
      goneAt: now,
      lastError: reason,
      lastStatus: status,
      lastFetchedAt: now,
    });
    run.tally.retired += 1;
  }

  /**
   * Pages the site's robots.txt now asks readers to stay away from, whether or not this read
   * would have got to them: what was learned from them stops answering.
   */
  private async retireDisallowed(
    tx: TenantTx,
    run: Run,
    allows: (url: string) => boolean,
  ): Promise<void> {
    const rows = await tx
      .select()
      .from(schema.knowledgeWebPages)
      .where(
        and(
          eq(schema.knowledgeWebPages.webSourceId, run.web.id),
          isNull(schema.knowledgeWebPages.goneAt),
          isNotNull(schema.knowledgeWebPages.documentId),
        ),
      );
    for (const row of rows) {
      if (!allows(row.url)) await this.retire(tx, run, row, SKIP_TEXT.robots, null);
    }
  }

  /**
   * Pages of the website that this read did not meet. They are retired only when the read was
   * complete and trouble-free: a site that failed to answer, or a read that ran out of time, says
   * nothing about the pages it did not get to.
   */
  private async retireUnseen(tx: TenantTx, run: Run, reason: string): Promise<void> {
    const rows = await tx
      .select()
      .from(schema.knowledgeWebPages)
      .where(
        and(
          eq(schema.knowledgeWebPages.webSourceId, run.web.id),
          isNull(schema.knowledgeWebPages.goneAt),
          isNotNull(schema.knowledgeWebPages.documentId),
        ),
      );
    for (const row of rows) {
      if (!run.seen.has(row.url)) await this.retire(tx, run, row, reason, null);
    }
  }

  private async finish(run: Run, report: CrawlReport | null, startedAt: Date): Promise<void> {
    const { tally, web } = run;
    await this.tx(run.tenantId, async (tx) => {
      const now = this.clock();
      const stopped = report?.stopped ?? 'trouble';
      const trouble = stopped !== 'done' && stopped !== 'pages';
      if (report?.robots === 'read') await this.retireDisallowed(tx, run, report.allows);
      if (report && !trouble && tally.failed === 0 && tally.kept > 0) {
        await this.retireUnseen(
          tx,
          run,
          stopped === 'pages'
            ? 'This page is past the limit of pages for this website.'
            : 'The site does not link to this page or list it any more.',
        );
      }
      const result: WebSyncResult =
        tally.kept === 0 ? 'failed' : tally.failed > 0 || trouble ? 'partial' : 'succeeded';
      const summary: WebSyncSummary = {
        startedAt: startedAt.toISOString(),
        finishedAt: now.toISOString(),
        pages: tally.kept,
        added: tally.added,
        updated: tally.updated,
        unchanged: tally.unchanged,
        retired: tally.retired,
        skipped: { ...tally.skipped },
        problems: tally.problems,
        truncated: stopped !== 'done',
        robots: report?.robots ?? 'missing',
        sitemaps: report?.sitemaps ?? 0,
      };
      // The schedule may have been changed while the read went on.
      const [current] = await tx
        .select({ schedule: schema.knowledgeWebSources.schedule })
        .from(schema.knowledgeWebSources)
        .where(eq(schema.knowledgeWebSources.id, web.id))
        .for('update');
      await tx
        .update(schema.knowledgeWebSources)
        .set({
          state: 'idle',
          leaseUntil: null,
          lastRunAt: now,
          lastResult: result,
          lastRun: summary,
          nextRunAt: nextRunAfter(current?.schedule ?? web.schedule, now, result),
          updatedAt: now,
        })
        .where(eq(schema.knowledgeWebSources.id, web.id));
      await appendAudit(tx, {
        actorType: 'system',
        actorId: ACTOR,
        action: 'knowledge.web_synced',
        targetType: 'knowledge_web_source',
        targetId: toPublicId('webSource', web.id),
        outcome: result === 'failed' ? 'failed' : 'success',
        data: {
          result,
          pages: tally.kept,
          added: tally.added,
          updated: tally.updated,
          unchanged: tally.unchanged,
          retired: tally.retired,
          failed: tally.failed,
          truncated: summary.truncated,
        },
      });
    });
  }
}
