import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Customer } from './actions-support.js';
import { join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * Which customer's memory a conversation belongs to, for the card in the inbox that shows what the
 * AI remembers. Only the customer's id is given; what is remembered comes from the memory API,
 * which checks the person's own grants again. A person who cannot see the conversation, or may not
 * read memory in its brand, learns nothing.
 */

let slice: Slice;
let shop: Shop;
let ela: Customer;

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'convmem');
  ela = await Customer.open(slice, shop);
  await ela.say('Hello, I have a question about my order');
});

afterAll(async () => {
  await slice?.close();
});

const customerOf = (client: Shop['owner'], conversationId = ela.conversationId) =>
  client.get(`/v1/admin/memory/conversations/${conversationId}`);

describe('the memory customer of a conversation', () => {
  it('names the customer whose conversation it is', async () => {
    const found = await customerOf(shop.owner);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body).toEqual({ customerId: ela.visitor.principalId });
    expect(found.headers['cache-control']).toBe('no-store');
    // The id leads to what the memory API already shows.
    const detail = await shop.owner.get(`/v1/admin/memory/customers/${found.body.customerId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.customer.id).toBe(ela.visitor.principalId);
  });

  it('gives the right customer when several are talking', async () => {
    const sana = await Customer.open(slice, shop);
    await sana.say('Hi, is anyone there?');
    expect((await customerOf(shop.owner, sana.conversationId)).body.customerId).toBe(
      sana.visitor.principalId,
    );
    expect((await customerOf(shop.owner)).body.customerId).toBe(ela.visitor.principalId);
    expect(sana.visitor.principalId).not.toBe(ela.visitor.principalId);
  });

  it('is for people who may read memory in the conversation’s brand', async () => {
    const supervisor = await join(slice, shop, 'Sam Supervisor', 'supervisor');
    expect((await customerOf(supervisor.client)).body).toEqual({
      customerId: ela.visitor.principalId,
    });
    // A support agent sees the conversation but holds no memory permission.
    const agent = await join(slice, shop, 'Pia Agent', 'agent');
    const refused = await customerOf(agent.client);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain(ela.visitor.principalId);
  });

  it('does not exist for a person who cannot see the conversation', async () => {
    // A supervisor of another brand reads memory there, but this conversation is not theirs.
    const other = await connectedTenant(slice, 'convmem2');
    expect((await customerOf(other.owner)).status).toBe(404);
    const second = await shop.owner.post('/v1/admin/brands', {
      workspaceId: (await shop.owner.get('/v1/admin/workspaces')).body.items[0].id,
      name: 'Other brand',
      allowedOrigins: ['https://other-brand.example'],
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const scoped = await join(slice, shop, 'Bea Brandsupervisor', 'supervisor', {
      type: 'brand',
      id: second.body.id,
    });
    expect((await customerOf(scoped.client)).status).toBe(404);
  });

  it('refuses ids that are not conversations', async () => {
    for (const id of ['conv_nope', 'cus_nope', '123', ela.visitor.principalId]) {
      expect((await customerOf(shop.owner, id)).status, id).toBe(404);
    }
  });

  it('needs a signed-in member of the workspace', async () => {
    const response = await fetch(
      `${slice.baseUrl}/v1/admin/memory/conversations/${ela.conversationId}`,
    );
    expect([401, 403]).toContain(response.status);
  });
});
