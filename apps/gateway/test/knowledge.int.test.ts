import { randomUUID } from 'node:crypto';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { EicarScanner, type Scanner, type ScanVerdict } from '../src/knowledge/scanner.js';
import { tinyPdf } from './fixtures.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/** The mock model; `answer` makes it reply with fixed text (for citation checks). */
function answeringModel() {
  const base = createMockModel();
  const state: { answer: string | null; lastPrompt: string } = { answer: null, lastPrompt: '' };
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      state.lastPrompt = JSON.stringify(call.prompt);
      const result = await base.doGenerate(call);
      return state.answer ? { ...result, content: [{ type: 'text', text: state.answer }] } : result;
    },
  };
  return { model, state };
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** The development scanner, switched off on demand as when ClamAV restarts. */
class SwitchableScanner implements Scanner {
  down = false;
  private readonly engine = new EicarScanner();

  scan(bytes: Uint8Array): Promise<ScanVerdict> {
    if (this.down) {
      return Promise.resolve({ clean: false, engine: 'clamav', reason: 'scan_unavailable' });
    }
    return this.engine.scan(bytes);
  }
}
const scanner = new SwitchableScanner();

const answering = answeringModel();
let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let publicSource: string;
let internalSource: string;

async function addDocument(sourceId: string, body: Record<string, unknown>) {
  const added = await shop.owner.post(`/v1/admin/knowledge/sources/${sourceId}/documents`, body);
  expect(added.status, JSON.stringify(added.body)).toBe(202);
  await slice.drain();
  const document = await shop.owner.get(`/v1/admin/knowledge/documents/${added.body.id}`);
  return document.body as Record<string, any>;
}

/** Makes waiting ingestion retries due now, as if their backoff had passed, and runs them. */
async function retryIngestion(attempts?: number) {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: new Date(), ...(attempts ? { attempts } : {}) })
      .where(
        and(
          eq(schema.outboxEvents.topic, 'knowledge.ingest'),
          isNull(schema.outboxEvents.processedAt),
        ),
      ),
  );
  await slice.drain();
}

async function search(query: string, audience: 'customer' | 'staff' = 'customer') {
  const found = await shop.owner.post('/v1/admin/knowledge/search', {
    query,
    brandId: shop.brand.id,
    audience,
  });
  expect(found.status).toBe(200);
  return found.body.items as Array<Record<string, any>>;
}

beforeAll(async () => {
  slice = await startSlice({ model: answering.model, scanner });
  shop = await connectedTenant(slice, 'kb');
  tenantId = fromPublicId('tenant', shop.tenantId);
  const created = await shop.owner.post('/v1/admin/knowledge/sources', {
    brandId: shop.brand.id,
    name: 'Help centre',
  });
  expect(created.status).toBe(201);
  publicSource = created.body.id;
  const internal = await shop.owner.post('/v1/admin/knowledge/sources', {
    brandId: shop.brand.id,
    name: 'Staff handbook',
    visibility: 'internal',
  });
  internalSource = internal.body.id;
});

afterAll(async () => {
  await slice?.close();
});

describe('ingestion', () => {
  it('turns Markdown, HTML and PDF into searchable passages that keep their section', async () => {
    const markdown = await addDocument(publicSource, {
      title: 'Returns policy',
      url: 'https://kb.example/returns',
      content: {
        mediaType: 'text/markdown',
        text: '# Returns\n\nYou can return unworn items within 30 days of delivery.\n\n# Shipping\n\nWe ship to Lahore, Karachi and Islamabad within 3 days.',
      },
    });
    expect(markdown.current).toMatchObject({ version: 1, state: 'ready', chunkCount: 2 });
    expect(markdown.freshness).toBe('current');

    const html = await addDocument(publicSource, {
      title: 'Refunds',
      content: {
        mediaType: 'text/html',
        text: '<html><body><script>alert("x")</script><h2>Refund timing</h2><p>Refunds reach your card in 5 to 7 working days.</p></body></html>',
      },
    });
    expect(html.current.state).toBe('ready');
    const [version] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.documentVersions)
        .where(eq(schema.documentVersions.documentId, fromPublicId('document', html.id))),
    );
    expect(version?.text).toContain('## Refund timing');
    expect(version?.text).not.toContain('alert');
    expect(version?.raw).toBeNull();

    const pdf = await addDocument(publicSource, {
      title: 'Gift wrapping',
      content: {
        mediaType: 'application/pdf',
        base64: tinyPdf('Gift wrapping costs 200 rupees per parcel.').toString('base64'),
      },
    });
    expect(pdf.current).toMatchObject({ state: 'ready', mediaType: 'application/pdf' });

    const [top] = await search('How many days do I have to return an item?');
    expect(top).toMatchObject({ title: 'Returns policy', heading: 'Returns', version: 1 });
    const [gift] = await search('gift wrapping price');
    expect(gift?.title).toBe('Gift wrapping');
  });

  it('refuses malware and files that are not what they claim, and keeps nothing of them', async () => {
    const infected = await addDocument(publicSource, {
      title: 'Test file',
      content: { mediaType: 'text/plain', text: `hello ${EICAR}` },
    });
    expect(infected.latest).toMatchObject({ state: 'rejected' });
    expect(infected.latest.error).toContain('malware');
    expect(infected.current).toBeNull();

    const fakePdf = await addDocument(publicSource, {
      title: 'Not a PDF',
      content: {
        mediaType: 'application/pdf',
        base64: Buffer.from('just text').toString('base64'),
      },
    });
    expect(fakePdf.latest).toMatchObject({ state: 'rejected' });

    const png = await addDocument(publicSource, {
      title: 'Image as text',
      content: {
        mediaType: 'text/plain',
        base64: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
        ]).toString('base64'),
      },
    });
    expect(png.latest).toMatchObject({ state: 'rejected' });

    const quarantine = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select({ raw: schema.documentVersions.raw }).from(schema.documentVersions),
    );
    expect(quarantine.every((v) => v.raw === null)).toBe(true);

    const huge = await shop.owner.post(`/v1/admin/knowledge/sources/${publicSource}/documents`, {
      title: 'Too big',
      content: { mediaType: 'text/plain', text: 'x'.repeat(5 * 1024 * 1024 + 1) },
    });
    expect([413, 422]).toContain(huge.status);
  });

  it('waits while the scanner is starting, and refuses uploads it can never scan', async () => {
    scanner.down = true;
    try {
      const waiting = await addDocument(publicSource, {
        title: 'Delivery areas',
        content: { mediaType: 'text/plain', text: 'We deliver to Lahore, Karachi and Multan.' },
      });
      expect(waiting.latest).toMatchObject({ state: 'processing' });
      scanner.down = false;
      await retryIngestion();
      const ready = await shop.owner.get(`/v1/admin/knowledge/documents/${waiting.id}`);
      expect(ready.body.current).toMatchObject({ state: 'ready' });

      scanner.down = true;
      const stuck = await addDocument(publicSource, {
        title: 'Never scanned',
        content: { mediaType: 'text/plain', text: 'This upload never gets a scan.' },
      });
      expect(stuck.latest).toMatchObject({ state: 'processing' });
      // The last attempt: the upload is refused and its bytes are dropped.
      await retryIngestion(9);
      const refused = await shop.owner.get(`/v1/admin/knowledge/documents/${stuck.id}`);
      expect(refused.body.latest).toMatchObject({ state: 'rejected' });
      expect(refused.body.latest.error).toContain('could not be scanned');
    } finally {
      scanner.down = false;
    }
  });

  it('keeps the old version answering until the new one is ready, then replaces it', async () => {
    const doc = await addDocument(publicSource, {
      title: 'Opening hours',
      content: { mediaType: 'text/plain', text: 'We are open from 9 to 5, Monday to Saturday.' },
    });
    const added = await shop.owner.post(`/v1/admin/knowledge/documents/${doc.id}/versions`, {
      content: {
        mediaType: 'text/plain',
        text: 'We are open from 10 to 6, every day except Friday.',
      },
    });
    expect(added.status).toBe(202);
    expect(added.body.current.version).toBe(1);
    expect(added.body.latest).toMatchObject({ version: 2, state: 'queued' });
    const [before] = await search('opening hours Monday');
    expect(before?.text).toContain('9 to 5');
    await slice.drain();
    const after = await search('opening hours every day');
    expect(after[0]?.text).toContain('10 to 6');
    expect(after.some((p) => p.text.includes('9 to 5'))).toBe(false);
  });
});

describe('retrieval rules', () => {
  it('uses internal sources for staff only, and drops retired, expired and stale documents', async () => {
    await addDocument(internalSource, {
      title: 'Discount authority',
      content: {
        mediaType: 'text/plain',
        text: 'Staff may approve a courtesy discount of 10 percent.',
      },
    });
    expect(await search('courtesy discount percent')).toEqual([]);
    expect((await search('courtesy discount percent', 'staff'))[0]?.title).toBe(
      'Discount authority',
    );

    const retired = await addDocument(publicSource, {
      title: 'Old warranty',
      content: { mediaType: 'text/plain', text: 'The blender warranty lasts one year.' },
    });
    expect((await search('blender warranty'))[0]?.title).toBe('Old warranty');
    await shop.owner.post(`/v1/admin/knowledge/documents/${retired.id}/retire`);
    expect(await search('blender warranty')).toEqual([]);

    const seasonal = await addDocument(publicSource, {
      title: 'Eid sale',
      content: {
        mediaType: 'text/plain',
        text: 'The Eid sale gives 20 percent off all prayer mats.',
        validUntil: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    expect(seasonal.freshness).toBe('expired');
    expect(await search('Eid sale prayer mats')).toEqual([]);

    const reviewed = await shop.owner.post('/v1/admin/knowledge/sources', {
      brandId: shop.brand.id,
      name: 'Monthly reviewed',
      reviewEveryDays: 30,
    });
    const stale = await addDocument(reviewed.body.id, {
      title: 'Courier partners',
      content: { mediaType: 'text/plain', text: 'Our courier partners are TCS and Leopards.' },
    });
    // Nobody confirmed it for 31 days: it stops grounding answers until reviewed.
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.documentVersions)
        .set({ readyAt: new Date(Date.now() - 31 * 86_400_000) })
        .where(eq(schema.documentVersions.documentId, fromPublicId('document', stale.id))),
    );
    expect(await search('courier partners TCS')).toEqual([]);
    const confirmed = await shop.owner.post(`/v1/admin/knowledge/documents/${stale.id}/review`);
    expect(confirmed.body.freshness).toBe('current');
    expect((await search('courier partners TCS'))[0]?.title).toBe('Courier partners');
  });

  it('finds Urdu and Hindi passages by their words', async () => {
    await addDocument(publicSource, {
      title: 'واپسی',
      content: { mediaType: 'text/plain', text: 'آپ تیس دن میں سامان واپس کر سکتے ہیں۔' },
    });
    await addDocument(publicSource, {
      title: 'वापसी',
      content: { mediaType: 'text/plain', text: 'आप तीस दिनों में सामान वापस कर सकते हैं।' },
    });
    expect((await search('سامان واپس'))[0]?.title).toBe('واپسی');
    expect((await search('सामान वापस'))[0]?.title).toBe('वापसी');
  });
});

describe('answers from knowledge', () => {
  async function chat(text: string) {
    const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await visitor.open();
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      firstMessage: text,
      clientMessageId: randomUUID(),
    });
    await slice.drain();
    return { visitor, conversationId: started.body.id as string };
  }

  it('cite only retrieved passages, and customers see the sources', async () => {
    const detail = await shop.owner.get(`/v1/admin/agents/${shop.agentId}`);
    const base = detail.body.published.config;
    await shop.owner.put(`/v1/admin/agents/${shop.agentId}/draft`, {
      config: { ...base, knowledgeSourceIds: [publicSource, internalSource] },
    });
    const published = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/publish`, {});
    expect(published.status).toBe(200);

    // [1] is the real passage; [7] matches nothing that was retrieved and must disappear.
    answering.state.answer =
      'You can return unworn items within 30 days [1]. Delivery is free [7].';
    const { visitor, conversationId } = await chat('Can I return shoes I have not worn?');
    expect(answering.state.lastPrompt).toContain('<reference_passages>');
    // Internal sources never reach a customer answer.
    expect(answering.state.lastPrompt).not.toContain('courtesy discount');

    const history = await visitor.call(
      'GET',
      `/v1/widget/conversations/${conversationId}/messages`,
    );
    const reply = history.body.items.find(
      (m: { sender: { kind: string } }) => m.sender.kind === 'ai_agent',
    );
    // The name customers see is the agent's configured role, not a name set in Chatwoot.
    expect(reply.sender.displayName).toBe(base.displayName);
    expect(reply.parts[0].text).toBe(
      'You can return unworn items within 30 days [1]. Delivery is free.',
    );
    expect(reply.parts.slice(1)).toEqual([
      expect.objectContaining({
        type: 'source',
        title: 'Returns policy',
        url: 'https://kb.example/returns',
        version: 'v1',
        freshness: 'current',
      }),
    ]);

    const runs = await shop.owner.get(`/v1/admin/runs?conversationId=${conversationId}`);
    const run = await shop.owner.get(`/v1/admin/runs/${runs.body.items[0].id}`);
    const retrieval = run.body.steps.find((s: { kind: string }) => s.kind === 'retrieval');
    expect(retrieval.detail.passages).toBeGreaterThan(0);
    answering.state.answer = null;
  });

  it('refuse to publish an agent with a source from another brand or a retired one', async () => {
    const detail = await shop.owner.get(`/v1/admin/agents/${shop.agentId}`);
    const base = detail.body.published.config;
    await shop.owner.patch(`/v1/admin/knowledge/sources/${internalSource}`, { status: 'retired' });
    await shop.owner.put(`/v1/admin/agents/${shop.agentId}/draft`, {
      config: { ...base, knowledgeSourceIds: [internalSource] },
    });
    const refused = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/publish`, {});
    expect(refused.status).toBe(422);
  });

  it('keep each tenant to its own knowledge', async () => {
    const other = await connectedTenant(slice, 'kb-other');
    const listed = await other.owner.get('/v1/admin/knowledge/sources');
    expect(listed.body.items).toEqual([]);
    const foreign = await other.owner.get(`/v1/admin/knowledge/sources/${publicSource}/documents`);
    expect(foreign.status).toBe(404);
    const found = await other.owner.post('/v1/admin/knowledge/search', {
      query: 'return unworn items',
      brandId: shop.brand.id,
    });
    expect(found.status).toBe(404);
    const registry = slice.worker.get(AuthorityRegistry);
    expect(registry).toBeDefined();
  });
});
