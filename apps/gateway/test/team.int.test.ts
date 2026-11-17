import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * The team on the chat's home screen (W17): who is online, as the first name and photo each
 * chose, and nothing else about them; how soon people usually reply, only once enough chats can
 * say it.
 */
let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'team');
});

afterAll(async () => {
  await slice?.close();
});

const session = async () => {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  return (await visitor.open()) as { config: Record<string, any> };
};

describe('the team customers see', () => {
  it('starts as the first word of the name, and keeps an address that is not https out', async () => {
    const mine = await shop.owner.get('/v1/inbox/profile');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    // connectedTenant signs the owner up as "team Owner".
    expect(mine.body).toEqual({ publicName: null, photoUrl: null, shownAs: 'team' });
    const plain = await shop.owner.patch('/v1/inbox/profile', {
      photoUrl: 'http://cdn.team.example/me.jpg',
    });
    expect(plain.status).toBe(422);
    const saved = await shop.owner.patch('/v1/inbox/profile', {
      publicName: 'Sara',
      photoUrl: 'https://cdn.team.example/sara.jpg',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toEqual({
      publicName: 'Sara',
      photoUrl: 'https://cdn.team.example/sara.jpg',
      shownAs: 'Sara',
    });
  });

  it('shows who is online, by first name and photo only, and nobody when away', async () => {
    await shop.owner.put('/v1/inbox/availability', { status: 'online' });
    await shop.owner.post('/v1/inbox/availability/ping', { active: true });
    const online = await session();
    expect(online.config.team).toEqual({
      online: [{ name: 'Sara', photoUrl: 'https://cdn.team.example/sara.jpg' }],
      // Too few chats to say how soon people reply.
      replyMinutes: null,
    });
    expect(online.config.availability.staffOnline).toBe(true);
    // Never the full name or the email.
    const text = JSON.stringify(online.config);
    expect(text).not.toContain('team Owner');
    expect(text).not.toContain('team-owner@example.com');

    await shop.owner.put('/v1/inbox/availability', { status: 'away' });
    const away = await session();
    expect(away.config.team.online).toEqual([]);
    expect(away.config.availability.staffOnline).toBe(false);
  });

  it('clears what was chosen with null', async () => {
    const cleared = await shop.owner.patch('/v1/inbox/profile', { publicName: null });
    expect(cleared.body).toEqual({
      publicName: null,
      photoUrl: 'https://cdn.team.example/sara.jpg',
      shownAs: 'team',
    });
  });
});
