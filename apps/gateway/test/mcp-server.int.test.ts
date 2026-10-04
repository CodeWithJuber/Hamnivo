import { randomUUID } from 'node:crypto';
import { MEMORY_NOTICE_VERSION } from '@hamnivo/contracts';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentHashOf } from '../src/memory/writer.service.js';
import { withTwoStep } from './developer-support.js';
import { customerStarts, join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, type Visitor } from './slice-harness.js';

/**
 * Hamnivo's own MCP server (`/mcp`): who may call it, what each read-only tool returns and never
 * returns (private notes, contact details, memory the customer did not agree to), the key's own
 * scope, the audit record of every call and the limit on calls.
 */

let slice: Slice;
let north: Shop;
let outlet: Shop;
let admin: Awaited<ReturnType<typeof withTwoStep>>;
let tenantId: string;
/** Conversations: an AI-answered one with a private note, one handed to people, one of the outlet. */
let c1: { conversationId: string; visitor: Visitor };
let c2: { conversationId: string; visitor: Visitor };
let c3: { conversationId: string; visitor: Visitor };
let all: { id: string; secret: string };

const NOTE = 'Internal: courier delayed on zebra-4412';
const mcpUrl = () => new URL('/mcp', slice.baseUrl).href;

async function key(permissions: string[], scope?: Record<string, unknown>) {
  const created = await admin.post('/v1/admin/api-keys', {
    name: 'AI assistant',
    permissions,
    expiresInDays: 30,
    ...(scope ? { scope } : {}),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as { id: string; secret: string };
}

const rpc = (secret: string | null, body: unknown, headers: Record<string, string> = {}) =>
  fetch(mcpUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

async function connect(secret: string) {
  const client = new McpClient({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl()), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    }),
  );
  return client;
}

/** One tool call: what it returned as data, or the words of the refusal. */
async function ask(client: McpClient, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return {
    isError: result.isError === true,
    text: content[0]?.text ?? '',
    data: (result.structuredContent ?? {}) as Record<string, any>,
  };
}

const toolAudits = () =>
  withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'mcp.tool_called'))
      .orderBy(schema.auditEvents.seq),
  );

/** A record written straight to the database, as the AI's memory writer would. */
async function remember(
  visitor: Visitor,
  shop: Shop,
  fields: Partial<typeof schema.memoryRecords.$inferInsert> & { key: string; value: string },
) {
  const { value, ...rest } = fields;
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx.insert(schema.memoryRecords).values({
      tenantId,
      workspaceId: fromPublicId('workspace', shop.workspaceId),
      brandId: fromPublicId('brand', shop.brand.id),
      subjectId: fromPublicId('customer', visitor.principalId),
      scope: 'person',
      kind: 'preference',
      payload: { value },
      contentHash: contentHashOf('preference', fields.key, value),
      sourceType: 'customer_statement',
      evidenceStatus: 'supported',
      writtenByType: 'customer',
      writeReason: 'customer_correction',
      purpose: 'test',
      allowedPurposes: ['ai_replies', 'staff_context'],
      allowedRoles: ['customer', 'staff', 'ai'],
      sensitivity: 'normal',
      retentionClass: 'long',
      policyVersion: 'memory-write/1',
      status: 'active',
      reviewStatus: 'auto',
      validFrom: new Date(Date.now() - 3_600_000),
      observedAt: new Date(Date.now() - 3_600_000),
      ...rest,
    }),
  );
}

beforeAll(async () => {
  slice = await startSlice({ env: { MCP_RATE_LIMIT_PER_MINUTE: '14' } });
  north = await connectedTenant(slice, 'mcp');
  tenantId = fromPublicId('tenant', north.tenantId);
  // A second brand of the same tenant, with its own Chatwoot account.
  const brand = await north.owner.post('/v1/admin/brands', {
    workspaceId: north.workspaceId,
    name: 'mcp Outlet',
    allowedOrigins: ['https://outlet-mcp.example'],
  });
  const connection = await north.owner.post('/v1/admin/authority/connections', {
    brandId: brand.body.id,
  });
  const agents = await north.owner.get('/v1/admin/agents');
  const agentId = agents.body.items.find((a: { brandId: string }) => a.brandId === brand.body.id)
    ?.id as string;
  await north.owner.post(`/v1/admin/agents/${agentId}/publish`, {});
  outlet = {
    ...north,
    agentId,
    brand: brand.body,
    connection: connection.body,
    hostOrigin: 'https://outlet-mcp.example',
  };
  admin = await withTwoStep(slice.gw.app, north.owner, 'mcp-owner@example.com');
  c1 = await customerStarts(slice, north, 'Where is my order HM-2048? It is a red kettle.');
  c2 = await customerStarts(slice, north, 'My blue teapot arrived cracked.');
  const handoff = await c2.visitor.call(
    'POST',
    `/v1/widget/conversations/${c2.conversationId}/handoff`,
    {
      clientRequestId: randomUUID(),
      note: 'please, a person',
    },
  );
  expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
  c3 = await customerStarts(slice, outlet, 'Do you sell an olive backpack?');
  await slice.drain();
  const note = await north.owner.post(`/v1/conversations/${c1.conversationId}/messages`, {
    clientMessageId: randomUUID(),
    text: NOTE,
    visibility: 'internal',
  });
  expect(note.status, JSON.stringify(note.body)).toBe(202);
  await slice.drain();
  all = await key(['mcp.read']);
});

afterAll(async () => {
  await slice?.close();
});

describe('who may call it', () => {
  it('needs an API key that holds mcp.read', async () => {
    const none = await rpc(null, INITIALIZE);
    expect(none.status).toBe(401);
    const wrong = await rpc(`hv_live_${'a'.repeat(12)}_${'B'.repeat(43)}`, INITIALIZE);
    expect(wrong.status).toBe(401);
    const reports = await key(['analytics.read']);
    const denied = await rpc(reports.secret, INITIALIZE);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe('SCOPE_DENIED');
    const allowed = await rpc(all.secret, INITIALIZE);
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      result: { serverInfo: { name: string }; instructions: string };
    };
    expect(body.result.serverInfo.name).toBe('hamnivo');
    expect(body.result.instructions).toContain('untrusted');
  });

  it('refuses a signed-in person’s session, a web page, and anything but POST', async () => {
    const session = await fetch(mcpUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: north.owner.cookieHeader(),
        'x-hamnivo-tenant': north.tenantId,
      },
      body: JSON.stringify(INITIALIZE),
    });
    expect(session.status).toBe(401);
    const page = await rpc(all.secret, INITIALIZE, { origin: 'https://evil.example' });
    expect(page.status).toBe(403);
    expect(((await page.json()) as { code: string }).code).toBe('ORIGIN_NOT_ALLOWED');
    const get = await fetch(mcpUrl(), { headers: { authorization: `Bearer ${all.secret}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const gone = await fetch(mcpUrl(), { method: 'DELETE' });
    expect(gone.status).toBe(405);
  });

  it('stops working when the key is revoked or expires', async () => {
    const short = await key(['mcp.read']);
    expect((await rpc(short.secret, INITIALIZE)).status).toBe(200);
    const revoked = await admin.post(`/v1/admin/api-keys/${short.id}/revoke`, {});
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect((await rpc(short.secret, INITIALIZE)).status).toBe(401);
  });

  it('lists read-only tools', async () => {
    const client = await connect(all.secret);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'get_customer_memory',
        'get_transcript',
        'list_open_handoffs',
        'search_conversations',
        'search_knowledge',
      ]);
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(tool.inputSchema.type).toBe('object');
      }
    } finally {
      await client.close();
    }
  });
});

describe('conversations', () => {
  it('searches what was said, and never what only the team wrote', async () => {
    const client = await connect((await key(['mcp.read'])).secret);
    try {
      const kettle = await ask(client, 'search_conversations', { query: 'red kettle' });
      expect(kettle.isError).toBe(false);
      const found = kettle.data.conversations as Record<string, any>[];
      expect(found.map((c) => c.conversationId)).toEqual([c1.conversationId]);
      expect(found[0]).toMatchObject({
        brand: 'mcp Shop',
        channel: 'chat',
        customer: { name: 'Visitor', identity: 'anonymous' },
      });
      const quoted = found[0]?.matches.find((m: { from: string }) => m.from === 'customer');
      expect(quoted?.snippet).toContain('red kettle');
      // The customer's address and number are not part of any answer.
      expect(kettle.text).not.toMatch(/@|email|phone/i);

      const note = await ask(client, 'search_conversations', { query: 'zebra-4412' });
      expect(note.data.conversations).toEqual([]);
      expect(note.text).not.toContain('courier');

      const byId = await ask(client, 'search_conversations', { query: c2.conversationId });
      expect(
        (byId.data.conversations as { conversationId: string }[]).map((c) => c.conversationId),
      ).toEqual([c2.conversationId]);

      const bad = await ask(client, 'search_conversations', { query: 'x' });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain('not valid');
    } finally {
      await client.close();
    }
  });

  it('reads a conversation as the customer sees it: no private notes', async () => {
    const client = await connect((await key(['mcp.read'])).secret);
    try {
      const transcript = await ask(client, 'get_transcript', { conversationId: c1.conversationId });
      expect(transcript.isError).toBe(false);
      const messages = transcript.data.messages as { from: string; text: string }[];
      expect(messages[0]).toMatchObject({
        from: 'customer',
        text: 'Where is my order HM-2048? It is a red kettle.',
      });
      expect(messages.some((m) => m.from === 'ai_assistant')).toBe(true);
      expect(transcript.text).not.toContain('courier');
      expect(transcript.text).not.toContain('zebra');
      expect(transcript.data.conversation).toMatchObject({
        conversationId: c1.conversationId,
        brand: 'mcp Shop',
      });
      // What the team wrote privately is in Chatwoot, so the staff view does have it.
      const staff = await north.owner.get(`/v1/inbox/conversations/${c1.conversationId}/messages`);
      expect(JSON.stringify(staff.body)).toContain('zebra-4412');

      const missing = await ask(client, 'get_transcript', { conversationId: 'conv_nothing' });
      expect(missing.isError).toBe(true);
      expect(missing.text).toBe('No conversation with this id is available.');
    } finally {
      await client.close();
    }
  });

  it('keeps a brand’s key to that brand, and gives another workspace nothing', async () => {
    const outletKey = await key(['mcp.read'], { type: 'brand', id: outlet.brand.id });
    const client = await connect(outletKey.secret);
    try {
      const mine = await ask(client, 'get_transcript', { conversationId: c3.conversationId });
      expect(mine.isError).toBe(false);
      const northOnes = await ask(client, 'get_transcript', { conversationId: c1.conversationId });
      expect(northOnes.isError).toBe(true);
      expect(northOnes.text).toBe('No conversation with this id is available.');
      const search = await ask(client, 'search_conversations', { query: 'kettle' });
      expect(search.data.conversations).toEqual([]);
      const olive = await ask(client, 'search_conversations', { query: 'olive backpack' });
      expect(
        (olive.data.conversations as { conversationId: string }[]).map((c) => c.conversationId),
      ).toEqual([c3.conversationId]);
      const memory = await ask(client, 'get_customer_memory', {
        conversationId: c1.conversationId,
      });
      expect(memory.isError).toBe(true);
      const handoffs = await ask(client, 'list_open_handoffs');
      expect(handoffs.data.handoffs).toEqual([]);
    } finally {
      await client.close();
    }

    // Another workspace's key reaches none of it.
    const stranger = await connectedTenant(slice, 'mcp-other');
    const strangerAdmin = await withTwoStep(
      slice.gw.app,
      stranger.owner,
      'mcp-other-owner@example.com',
    );
    const created = await strangerAdmin.post('/v1/admin/api-keys', {
      name: 'Other',
      permissions: ['mcp.read'],
      expiresInDays: 7,
    });
    const other = await connect(created.body.secret);
    try {
      const result = await ask(other, 'get_transcript', { conversationId: c1.conversationId });
      expect(result.isError).toBe(true);
      expect(
        (await ask(other, 'search_conversations', { query: 'kettle' })).data.conversations,
      ).toEqual([]);
    } finally {
      await other.close();
    }
  });
});

describe('knowledge', () => {
  it('searches what the AI answers from, keeping to the brands the key reaches', async () => {
    const source = await north.owner.post('/v1/admin/knowledge/sources', {
      brandId: north.brand.id,
      name: 'Help centre',
    });
    const handbook = await north.owner.post('/v1/admin/knowledge/sources', {
      brandId: north.brand.id,
      name: 'Staff handbook',
      visibility: 'internal',
    });
    const outletSource = await north.owner.post('/v1/admin/knowledge/sources', {
      brandId: outlet.brand.id,
      name: 'Outlet help',
    });
    const add = async (sourceId: string, title: string, text: string) => {
      const added = await north.owner.post(`/v1/admin/knowledge/sources/${sourceId}/documents`, {
        title,
        url: `https://help.example/${title.toLowerCase().replace(/\W+/g, '-')}`,
        content: { mediaType: 'text/markdown', text },
      });
      expect(added.status, JSON.stringify(added.body)).toBe(202);
    };
    await add(
      source.body.id,
      'Returns policy',
      '# Returns\n\nYou can return unworn items within 30 days of delivery.',
    );
    await add(
      handbook.body.id,
      'Refund approvals',
      '# Refunds\n\nEscalate any refund over 500 dollars to the finance lead.',
    );
    await add(
      outletSource.body.id,
      'Outlet returns',
      '# Outlet\n\nOutlet items are final sale and cannot be returned.',
    );
    await slice.drain();

    const client = await connect((await key(['mcp.read'])).secret);
    try {
      const found = await ask(client, 'search_knowledge', { query: 'return unworn items' });
      expect(found.isError).toBe(false);
      const results = found.data.results as Record<string, any>[];
      const policy = results.find((r) => r.document === 'Returns policy');
      expect(policy).toMatchObject({ brand: 'mcp Shop', audience: 'public' });
      expect(policy?.text).toContain('30 days');
      expect(policy?.documentId).toMatch(/^doc_/);
      const internal = await ask(client, 'search_knowledge', {
        query: 'refund over 500 finance lead',
      });
      expect(
        (internal.data.results as Record<string, any>[]).find(
          (r) => r.document === 'Refund approvals',
        ),
      ).toMatchObject({ audience: 'internal' });
      const onlyOutlet = await ask(client, 'search_knowledge', {
        query: 'returned',
        brandId: outlet.brand.id,
      });
      expect(
        (onlyOutlet.data.results as { brand: string }[]).every((r) => r.brand === 'mcp Outlet'),
      ).toBe(true);
      const unknown = await ask(client, 'search_knowledge', {
        query: 'returned',
        brandId: 'brd_nope',
      });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
    }

    const outletOnly = await connect(
      (await key(['mcp.read'], { type: 'brand', id: outlet.brand.id })).secret,
    );
    try {
      const scoped = await ask(outletOnly, 'search_knowledge', { query: 'return unworn items' });
      expect((scoped.data.results as { document: string }[]).map((r) => r.document)).not.toContain(
        'Returns policy',
      );
      const refused = await ask(outletOnly, 'search_knowledge', {
        query: 'return unworn items',
        brandId: north.brand.id,
      });
      expect(refused.isError).toBe(true);
    } finally {
      await outletOnly.close();
    }
  });
});

describe('customer memory', () => {
  it('shows only what the customer agreed to and may be used for the team', async () => {
    const client = await connect((await key(['mcp.read'])).secret);
    try {
      const before = await ask(client, 'get_customer_memory', {
        conversationId: c1.conversationId,
      });
      expect(before.data).toMatchObject({ consent: 'undecided', memories: [] });
      expect(before.data.note).toContain('not agreed');

      await remember(c1.visitor, north, { key: 'preferred_language', value: 'Urdu' });
      // Only for the AI, under review, past its date, or about one conversation: none is shown.
      await remember(c1.visitor, north, {
        key: 'delivery_note',
        value: 'ring the bell twice',
        allowedRoles: ['ai'],
      });
      await remember(c1.visitor, north, {
        key: 'size',
        value: 'medium',
        status: 'pending',
        reviewStatus: 'pending',
      });
      await remember(c1.visitor, north, {
        key: 'favourite_colour',
        value: 'green',
        expiresAt: new Date(Date.now() - 1000),
      });
      await remember(c1.visitor, north, {
        key: 'topic',
        value: 'a return',
        scope: 'conversation',
        conversationId: fromPublicId('conversation', c1.conversationId),
      });
      const declined = await ask(client, 'get_customer_memory', {
        conversationId: c1.conversationId,
      });
      expect(declined.data.memories).toEqual([]);

      const consent = await c1.visitor.call('POST', '/v1/widget/memory/consent', {
        state: 'granted',
        noticeVersion: MEMORY_NOTICE_VERSION,
      });
      expect(consent.status, JSON.stringify(consent.body)).toBe(200);
      const granted = await ask(client, 'get_customer_memory', {
        conversationId: c1.conversationId,
      });
      expect(granted.data).toMatchObject({
        consent: 'granted',
        customer: { name: 'Visitor', identity: 'anonymous', brand: 'mcp Shop' },
      });
      expect(granted.data.memories).toEqual([
        expect.objectContaining({
          key: 'preferred_language',
          value: 'Urdu',
          source: 'customer_statement',
          confirmed: false,
        }),
      ]);
      expect(granted.text).not.toContain('bell');
      expect(granted.text).not.toContain('green');

      const byCustomer = await ask(client, 'get_customer_memory', {
        customerId: granted.data.customer.id,
      });
      expect(byCustomer.data.memories).toHaveLength(1);
      const neither = await ask(client, 'get_customer_memory');
      expect(neither.isError).toBe(true);
      const both = await ask(client, 'get_customer_memory', {
        customerId: granted.data.customer.id,
        conversationId: c1.conversationId,
      });
      expect(both.isError).toBe(true);

      // A customer who withdraws is no longer shown.
      await c1.visitor.call('POST', '/v1/widget/memory/consent', {
        state: 'withdrawn',
        noticeVersion: MEMORY_NOTICE_VERSION,
      });
      const withdrawn = await ask(client, 'get_customer_memory', {
        conversationId: c1.conversationId,
      });
      expect(withdrawn.data).toMatchObject({ consent: 'withdrawn', memories: [] });
    } finally {
      await client.close();
    }
  });
});

describe('hand-offs', () => {
  it('lists conversations waiting for a person until someone takes them', async () => {
    const client = await connect((await key(['mcp.read'])).secret);
    try {
      const open = await ask(client, 'list_open_handoffs');
      expect(open.isError).toBe(false);
      const handoffs = open.data.handoffs as Record<string, any>[];
      expect(handoffs.map((h) => h.conversationId)).toEqual([c2.conversationId]);
      expect(handoffs[0]).toMatchObject({
        brand: 'mcp Shop',
        status: 'waiting_for_person',
        customer: { name: 'Visitor' },
      });
      expect(handoffs[0]?.waitingSince).toEqual(expect.any(String));
      expect(typeof handoffs[0]?.reason).toBe('string');
      expect(open.text).not.toContain('zebra');

      const claimed = await north.owner.post(
        `/v1/inbox/conversations/${c2.conversationId}/assign`,
        {
          to: { kind: 'me' },
        },
      );
      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
      const after = await ask(client, 'list_open_handoffs');
      expect(after.data.handoffs).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe('audit and limits', () => {
  it('records every tool call without what was asked or answered', async () => {
    const mine = await key(['mcp.read']);
    const client = await connect(mine.secret);
    try {
      await ask(client, 'search_conversations', { query: 'private zebra words' });
      await ask(client, 'get_transcript', { conversationId: c1.conversationId });
      // An id no conversation has: the last character always changes (an id ending in 0 kept it).
      const unknown = c3.conversationId.replace(/.$/, (last) => (last === '0' ? '1' : '0'));
      await ask(client, 'get_transcript', { conversationId: unknown });
      await ask(client, 'search_conversations', { query: 'x' });
    } finally {
      await client.close();
    }
    const rows = (await toolAudits()).filter((row) => row.actorId === mine.id);
    expect(rows.map((row) => [row.data.tool, row.outcome])).toEqual([
      ['search_conversations', 'success'],
      ['get_transcript', 'success'],
      ['get_transcript', 'denied'],
      ['search_conversations', 'failed'],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ actorType: 'service_account', action: 'mcp.tool_called' });
    }
    expect(rows[1]).toMatchObject({ targetType: 'conversation', targetId: c1.conversationId });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('private zebra words');
    expect(serialized).not.toContain('Where is my order');
    expect(rows[0]?.data).toMatchObject({ queryLength: 'private zebra words'.length });
    expect(rows[0]?.data.queryFingerprint).toMatch(/^[0-9a-f]{12}$/);
    // Listing the tools is not reading anything.
    expect(rows.map((row) => row.data.tool)).not.toContain('tools/list');
  });

  it('limits tool calls per key, and tells how long to wait', async () => {
    const limited = await key(['mcp.read']);
    const call = (n: number) =>
      rpc(limited.secret, {
        jsonrpc: '2.0',
        id: n,
        method: 'tools/call',
        params: { name: 'list_open_handoffs', arguments: {} },
      });
    for (let n = 1; n <= 14; n += 1) expect((await call(n)).status).toBe(200);
    const over = await call(15);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await over.json()) as { code: string; quota: { limit: string; max: number } };
    expect(body).toMatchObject({ code: 'RATE_LIMITED', quota: { max: 14 } });
    // Another key has its own budget, and reading the tool list costs none.
    expect((await rpc(all.secret, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(
      200,
    );
    expect(
      (await rpc(limited.secret, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status,
    ).toBe(200);
  });

  it('can be given by an owner or an administrator, and not by a role without it', async () => {
    const ola = await join(slice, north, 'Ola Admin', 'admin');
    const adminOptions = await ola.client.get('/v1/admin/api-keys/permissions');
    expect(adminOptions.status, JSON.stringify(adminOptions.body)).toBe(200);
    expect(adminOptions.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permission: 'mcp.read', grantable: true }),
      ]),
    );
    // A developer makes keys but cannot read conversations, so a key cannot carry it from them.
    const dana = await join(slice, north, 'Dana Developer', 'developer');
    const developerOptions = await dana.client.get('/v1/admin/api-keys/permissions');
    expect(developerOptions.status).toBe(200);
    expect(
      developerOptions.body.items.find((o: { permission: string }) => o.permission === 'mcp.read'),
    ).toMatchObject({ grantable: false });
  });
});
