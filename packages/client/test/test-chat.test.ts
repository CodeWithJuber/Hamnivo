import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HamnivoClient, MemoryStorage, prefixedStorage } from '../src/index.js';

/** The test chat the owner opens in Studio (A01): its own session, marked as a test. */

const API = 'https://api.test';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const session = (refreshToken: string) => ({
  accessToken: 'access',
  accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  refreshToken,
  principal: { id: 'cus_1', verified: false, displayName: null },
  config: {},
  conversations: [],
});

describe('a test chat', () => {
  it('says it is a test when it opens its session, and a normal chat does not', async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${API}/v1/widget/sessions`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(session('ses_x.one'), { status: 201 });
      }),
    );
    const options = { apiBase: API, widgetId: 'wid_test', hostOrigin: 'https://studio.test' };
    await new HamnivoClient({ ...options, storage: new MemoryStorage() }).connect();
    await new HamnivoClient({ ...options, test: true, storage: new MemoryStorage() }).connect();
    expect(bodies[0]).not.toHaveProperty('test');
    expect(bodies[1]).toMatchObject({ hostOrigin: 'https://studio.test', test: true });
  });
});

describe('storage under a prefix', () => {
  it('keeps what it stores apart from the same keys without the prefix', () => {
    const device = new MemoryStorage();
    const test = prefixedStorage(device, 'test:');
    device.setItem('hamnivo:wid_test:refresh', 'real-session');
    expect(test.getItem('hamnivo:wid_test:refresh')).toBeNull();
    test.setItem('hamnivo:wid_test:refresh', 'test-session');
    expect(device.getItem('hamnivo:wid_test:refresh')).toBe('real-session');
    expect(device.getItem('test:hamnivo:wid_test:refresh')).toBe('test-session');
    test.removeItem('hamnivo:wid_test:refresh');
    expect(device.getItem('test:hamnivo:wid_test:refresh')).toBeNull();
    expect(device.getItem('hamnivo:wid_test:refresh')).toBe('real-session');
  });

  it('gives a test chat its own session, never a real visitor’s', async () => {
    const resumed: (string | undefined)[] = [];
    server.use(
      http.post(`${API}/v1/widget/sessions`, async ({ request }) => {
        const body = (await request.json()) as { resumeToken?: string };
        resumed.push(body.resumeToken);
        return HttpResponse.json(session('ses_x.test'), { status: 201 });
      }),
    );
    const device = new MemoryStorage();
    device.setItem('hamnivo:wid_test:refresh', 'ses_x.real-visitor');
    const test = new HamnivoClient({
      apiBase: API,
      widgetId: 'wid_test',
      test: true,
      storage: prefixedStorage(device, 'test:'),
    });
    await test.connect();
    // It did not pick up the visitor's token, and what it kept is under its own name.
    expect(resumed).toEqual([undefined]);
    expect(device.getItem('hamnivo:wid_test:refresh')).toBe('ses_x.real-visitor');
    expect(device.getItem('test:hamnivo:wid_test:refresh')).toBe('ses_x.test');
  });
});
