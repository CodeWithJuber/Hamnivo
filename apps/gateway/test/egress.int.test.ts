import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ResolvedAddress } from '@hamnivo/adapters/net';
import { fromPublicId } from '@hamnivo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelFactory } from '../src/runtime/models.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * Requests the server makes at an address a tenant gave it, through the one egress guard
 * (`@hamnivo/adapters/net`): the tenant's own model servers (board 17) and MCP servers (D10). The
 * guard is tested on its own; here the gateway puts it to work: what is refused when an address is
 * given, the workspace's allowed hosts, and a name that turns private after the check.
 */

/** Host names the gateway resolves in these tests (DNS is replaced in both processes). */
const dns: Record<string, string[]> = {
  'llm.partner.example': ['93.184.216.34'],
  'mcp.partner.example': ['93.184.216.34'],
  'rebind.example.com': ['10.1.2.3'],
};

/** Counts the connections made to it: a refused request must never get this far. */
let sink: SocketServer;
let sinkPort = 0;
let connections = 0;

/** An OpenAI-compatible server the administrator trusts (EGRESS_TRUSTED_ORIGINS). */
let modelServer: Server;
let modelOrigin = '';
let modelMode: 'answer' | 'redirect' = 'answer';
const modelRequests: { url: string; authorization: string | undefined }[] = [];

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let factory: ModelFactory;
let tenantId = '';

beforeAll(async () => {
  sink = createSocketServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  sinkPort = (sink.address() as AddressInfo).port;

  modelServer = createServer((request, response) => {
    modelRequests.push({ url: request.url ?? '', authorization: request.headers.authorization });
    request.resume();
    request.on('end', () => {
      if (modelMode === 'redirect') {
        response.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello from the model server' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  modelOrigin = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;

  slice = await startSlice({
    env: { EGRESS_TRUSTED_ORIGINS: modelOrigin },
    egressResolver: async (host): Promise<ResolvedAddress[]> => {
      const addresses = dns[host];
      if (!addresses) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  });
  shop = await connectedTenant(slice, 'egressed', { publishAgent: false });
  tenantId = fromPublicId('tenant', shop.tenantId);
  factory = slice.gw.app.get(ModelFactory);
});

afterAll(async () => {
  await slice?.close();
  modelServer?.closeAllConnections();
  await new Promise<void>((resolve) => modelServer?.close(() => resolve()));
  await new Promise<void>((resolve) => sink?.close(() => resolve()));
});

/** Puts the workspace's allowed hosts (an empty list: any public host). */
async function allowHosts(patterns: string[]) {
  const current = await shop.owner.get('/v1/admin/network/egress');
  const saved = await shop.owner.put('/v1/admin/network/egress', {
    hosts: patterns.map((pattern) => ({ pattern })),
    version: current.body.version,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

describe('model servers a tenant names', () => {
  const connect = (baseUrl: string) =>
    shop.owner.post('/v1/admin/model-connections', {
      provider: 'openai-compatible',
      label: 'Our own server',
      baseUrl,
      apiKey: 'sk-test-0123456789abcd',
    });

  async function ask(connectionId: string) {
    const { model } = await factory.resolve(tenantId, {
      provider: 'openai-compatible',
      modelId: 'test-model',
      connectionId,
    } as never);
    return (model as LanguageModelV4).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });
  }

  it('refuses addresses outside the public internet before storing anything', async () => {
    const cases: [string, string][] = [
      ['http://llm.partner.example/v1', 'https://'],
      ['https://10.0.0.1/v1', 'private'],
      ['https://169.254.169.254/v1', 'private'],
      ['https://localhost:11434/v1', 'private'],
      ['https://[::1]/v1', 'private'],
      ['https://intranet/v1', 'private'],
      ['https://rebind.example.com/v1', 'private'],
      ['https://user:pw@llm.partner.example/v1', 'Enter the full address'],
    ];
    for (const [baseUrl, message] of cases) {
      const refused = await connect(baseUrl);
      expect(refused.status, baseUrl).toBe(422);
      expect(refused.body.fields[0].path, baseUrl).toBe('baseUrl');
      expect(refused.body.fields[0].message, baseUrl).toContain(message);
    }
    const listed = await shop.owner.get('/v1/admin/model-connections');
    expect(listed.body.items).toEqual([]);
  });

  it('accepts a public name, and holds it to the workspace’s allowed hosts', async () => {
    const created = await connect('https://llm.partner.example/v1');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.baseUrl).toBe('https://llm.partner.example/v1');
    // A name that does not resolve yet is accepted: it is checked again whenever the model is called.
    expect((await connect('https://not-yet.partner.example/v1')).status).toBe(201);
    await allowHosts(['hooks.example.com']);
    try {
      const refused = await connect('https://llm.partner.example/v1');
      expect(refused.status).toBe(422);
      expect(refused.body.fields[0]).toMatchObject({ path: 'baseUrl' });
      expect(refused.body.fields[0].message).toMatch(/allowed hosts/);
    } finally {
      await allowHosts([]);
    }
  });

  it('refuses a name that turned private after it was saved, without connecting', async () => {
    dns['llm.partner.example'] = ['93.184.216.34'];
    const created = await connect(`https://llm.partner.example:${sinkPort}/v1`);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // DNS now answers with this machine's address (rebinding): nothing may reach it.
    dns['llm.partner.example'] = ['127.0.0.1'];
    try {
      await expect(ask(created.body.id)).rejects.toMatchObject({ problem: 'private_address' });
      expect(connections).toBe(0);
    } finally {
      dns['llm.partner.example'] = ['93.184.216.34'];
    }
  });

  it('reaches a server the administrator trusts, with the connection’s key', async () => {
    const created = await connect(`${modelOrigin}/v1`);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const answer = await ask(created.body.id);
    expect(answer.content).toEqual([{ type: 'text', text: 'hello from the model server' }]);
    expect(modelRequests.at(-1)).toEqual({
      url: '/v1/chat/completions',
      authorization: 'Bearer sk-test-0123456789abcd',
    });
  });

  it('never follows a redirect from a model server', async () => {
    const created = await connect(`${modelOrigin}/v1`);
    const before = modelRequests.length;
    modelMode = 'redirect';
    try {
      await expect(ask(created.body.id)).rejects.toMatchObject({ problem: 'redirect' });
      expect(modelRequests.length).toBe(before + 1);
    } finally {
      modelMode = 'answer';
    }
  });
});

describe('MCP servers a tenant names', () => {
  let serverId = '';
  const addServer = (url: string) =>
    shop.owner.post('/v1/admin/mcp-servers', {
      brandId: shop.brand.id,
      label: 'Partner tools',
      url,
    });
  const url = () => `https://mcp.partner.example:${sinkPort}/mcp`;

  it('refuses addresses outside the public internet before storing anything', async () => {
    for (const address of [
      'http://mcp.partner.example/mcp',
      'https://10.0.0.1/mcp',
      'https://localhost/mcp',
      'https://[::1]/mcp',
      'https://rebind.example.com/mcp',
      'https://user:pw@mcp.partner.example/mcp',
    ]) {
      const refused = await addServer(address);
      expect(refused.status, address).toBe(422);
      expect(refused.body.fields[0].path, address).toBe('url');
    }
    expect((await shop.owner.get('/v1/admin/mcp-servers')).body.items).toEqual([]);
  });

  it('holds a server to the workspace’s allowed hosts, when it is added and when it is listed', async () => {
    const created = await addServer(url());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    serverId = created.body.id;
    await allowHosts(['hooks.example.com']);
    try {
      const refused = await addServer(`https://mcp.partner.example:${sinkPort}/other`);
      expect(refused.status).toBe(422);
      expect(refused.body.fields[0].message).toMatch(/allowed hosts/);
      const synced = await shop.owner.post(`/v1/admin/mcp-servers/${serverId}/sync`, {});
      expect(synced.status).toBe(503);
      expect(synced.body.detail).toBe('The server could not be listed (egress).');
    } finally {
      await allowHosts([]);
    }
    expect(connections).toBe(0);
  });

  it('refuses a name that turned private after the server was added, without connecting', async () => {
    dns['mcp.partner.example'] = ['127.0.0.1'];
    try {
      const synced = await shop.owner.post(`/v1/admin/mcp-servers/${serverId}/sync`, {});
      expect(synced.status).toBe(503);
      expect(synced.body.detail).toBe('The server could not be listed (egress).');
      const listed = await shop.owner.get('/v1/admin/mcp-servers');
      expect(listed.body.items[0].lastError).toBe('The server could not be listed (egress).');
      expect(connections).toBe(0);
    } finally {
      dns['mcp.partner.example'] = ['93.184.216.34'];
    }
  });
});
