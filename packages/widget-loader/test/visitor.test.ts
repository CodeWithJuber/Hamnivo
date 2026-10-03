import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Ack, BEAT_MS, type Env, keyFor, newKey, track, WATCH_MS } from '../src/visitor.js';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);

class Memory {
  items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => {
    this.items.set(key, value);
  };
}

function setup(overrides: Partial<Env> = {}) {
  const sent: Record<string, unknown>[] = [];
  const beacons: Record<string, unknown>[] = [];
  const told: string[] = [];
  const invites: { id: string; message: string }[] = [];
  const handlers = new Map<string, () => void>();
  const state = { url: 'https://shop.example/pricing', visible: true, optOut: false };
  let answer: Ack | null = { tracking: true, invite: null };
  const env: Env = {
    widgetId: 'wid_test',
    page: () => ({
      url: state.url,
      title: 'Pricing',
      referrer: 'https://www.google.com/',
      language: 'en-GB',
    }),
    optOut: () => state.optOut,
    visible: () => state.visible,
    listen: (event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    storage: new Memory(),
    random: bytes,
    post: async (body) => {
      sent.push(JSON.parse(body));
      return answer;
    },
    beacon: (body) => {
      beacons.push(JSON.parse(body));
    },
    onTracking: (key) => told.push(key),
    onInvite: (invite) => invites.push(invite),
    ...overrides,
  };
  return {
    env,
    sent,
    beacons,
    told,
    invites,
    handlers,
    state,
    answer: (next: Ack | null) => {
      answer = next;
    },
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('reporting where a visitor is', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the page at once, with its title, referrer and language, and tells the chat', async () => {
    const s = setup();
    track(s.env);
    await settle();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({
      widgetId: 'wid_test',
      event: 'view',
      url: 'https://shop.example/pricing',
      title: 'Pricing',
      referrer: 'https://www.google.com/',
      language: 'en-GB',
    });
    expect(s.sent[0]?.key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    // The chat gets the same key, once.
    expect(s.told).toEqual([s.sent[0]?.key]);
  });

  it('says "still here" every 20 seconds, and reports a page change without a reload as a view', async () => {
    const s = setup();
    track(s.env);
    await settle();
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(s.sent.map((m) => m.event)).toEqual(['view', 'beat']);
    // Nothing between beats while nothing changes.
    await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
    expect(s.sent).toHaveLength(2);
    // A site that changes pages without reloading is noticed within seconds.
    s.state.url = 'https://shop.example/shipping';
    await vi.advanceTimersByTimeAsync(WATCH_MS);
    expect(s.sent.map((m) => m.event)).toEqual(['view', 'beat', 'view']);
    expect(s.sent[2]?.url).toBe('https://shop.example/shipping');
    // The visitor is the same one throughout.
    expect(new Set(s.sent.map((m) => m.key)).size).toBe(1);
    expect(s.told).toHaveLength(1);
  });

  it('is quiet while the tab is hidden, and reports again when it is shown', async () => {
    const s = setup();
    track(s.env);
    await settle();
    s.state.visible = false;
    await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
    expect(s.sent).toHaveLength(1);
    s.state.visible = true;
    s.handlers.get('visibilitychange')?.();
    await settle();
    expect(s.sent.map((m) => m.event)).toEqual(['view', 'beat']);
  });

  it('starts with a view even when the page opened in a background tab, once it is shown', async () => {
    const s = setup();
    s.state.visible = false;
    track(s.env);
    await settle();
    expect(s.sent).toEqual([]);
    s.state.visible = true;
    s.handlers.get('visibilitychange')?.();
    await settle();
    expect(s.sent.map((m) => m.event)).toEqual(['view']);
  });

  it('says "left" when the page closes, in a way that survives the page', async () => {
    const s = setup();
    track(s.env);
    await settle();
    s.handlers.get('pagehide')?.();
    expect(s.beacons).toHaveLength(1);
    expect(s.beacons[0]).toMatchObject({ event: 'leave', url: 'https://shop.example/pricing' });
  });

  it('reports nothing for a browser that says Do Not Track or Global Privacy Control', async () => {
    const s = setup();
    s.state.optOut = true;
    const stop = track(s.env);
    await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
    expect(s.sent).toEqual([]);
    expect(s.handlers.size).toBe(0);
    expect(s.env.storage.getItem('hamnivo:wid_test:visitor')).toBeNull();
    stop();
  });

  it('stops for the page when the brand turns tracking off, and tells the chat nothing', async () => {
    const s = setup();
    s.answer({ tracking: false, invite: null });
    track(s.env);
    await settle();
    expect(s.told).toEqual([]);
    await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
    expect(s.sent).toHaveLength(1);
    // Nothing is sent when the page closes, either.
    s.handlers.get('pagehide')?.();
    expect(s.beacons).toEqual([]);
  });

  it('keeps going when the gateway does not answer, without telling the chat', async () => {
    const s = setup({
      post: async () => {
        throw new Error('offline');
      },
    });
    track(s.env);
    await settle();
    await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
    expect(s.told).toEqual([]);
  });

  it('shows each invitation once, however many reports carry it', async () => {
    const s = setup();
    s.answer({ tracking: true, invite: { id: 'a1', message: 'Need a hand?' } });
    track(s.env);
    await settle();
    await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
    expect(s.invites).toEqual([{ id: 'a1', message: 'Need a hand?' }]);
    // A different invitation is shown too.
    s.answer({ tracking: true, invite: { id: 'b2', message: 'Still there?' } });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(s.invites.map((i) => i.id)).toEqual(['a1', 'b2']);
  });

  it('stops everything when asked to', async () => {
    const s = setup();
    const stop = track(s.env);
    await settle();
    stop();
    await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
    expect(s.sent).toHaveLength(1);
    expect(s.handlers.size).toBe(0);
  });
});

describe('the visitor’s key', () => {
  it('is random, 22 characters of a web-safe alphabet, and different each time', () => {
    const a = newKey((n) => crypto.getRandomValues(new Uint8Array(n)));
    const b = newKey((n) => crypto.getRandomValues(new Uint8Array(n)));
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });

  it('is kept on the device for this website, and made again if what is kept is not a key', () => {
    const storage = new Memory();
    const env = { widgetId: 'wid_test', storage, random: bytes };
    const first = keyFor(env);
    expect(keyFor(env)).toBe(first);
    expect(storage.getItem('hamnivo:wid_test:visitor')).toBe(first);
    // Another brand's widget on the same site is another visitor.
    expect(keyFor({ ...env, widgetId: 'wid_other', random: (n) => bytes(n).reverse() })).not.toBe(
      first,
    );
    storage.setItem('hamnivo:wid_test:visitor', 'not a key!');
    expect(keyFor(env)).toBe(first);
  });

  it('is still made when the device keeps nothing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(keyFor({ widgetId: 'wid_test', storage: broken, random: bytes })).toMatch(
      /^[A-Za-z0-9_-]{22}$/,
    );
  });
});
