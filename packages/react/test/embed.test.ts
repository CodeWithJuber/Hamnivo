import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT,
  failLoader,
  fakeLoader,
  injectedScript,
  resetPage,
  settle,
  startLoader,
  WIDGET,
} from './helpers.js';

/**
 * The part that has no framework in it: loading the loader, following it, showing and hiding it,
 * and keeping the chat in step with who is signed in. @hamnivo/vue runs the same file and the same
 * tests. Every test starts from a page where nothing has loaded.
 */
type Embed = typeof import('../src/embed.js');
let embed: Embed;
const options = { widgetId: WIDGET, chatUrl: CHAT };

beforeEach(async () => {
  vi.resetModules();
  embed = await import('../src/embed.js');
});

afterEach(() => {
  // First the globals a test replaced (the server test removes document), then the page.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPage();
});

describe('loadHamnivo', () => {
  it('adds one async script from the origin of the chat address, with the settings as data attributes', () => {
    void embed.loadHamnivo({
      widgetId: WIDGET,
      chatUrl: 'https://chat.example.com/some/page?x=1#top',
      apiUrl: 'https://api.example.com/v1/',
      locale: 'ur',
      mode: 'panel',
      position: 'bottom-left',
      color: '#112233',
      container: '#chat',
      height: '500px',
      labels: { open: 'Chat', close: 'Close chat', title: 'Help' },
      nonce: 'abc123',
    });
    const scripts = document.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    const script = scripts[0] as HTMLScriptElement;
    expect(script.src).toBe('https://chat.example.com/loader.js');
    expect(script.async).toBe(true);
    expect({ ...script.dataset }).toEqual({
      widgetId: WIDGET,
      api: 'https://api.example.com/v1',
      locale: 'ur',
      mode: 'panel',
      position: 'bottom-left',
      color: '#112233',
      container: '#chat',
      height: '500px',
      label: 'Chat',
      closeLabel: 'Close chat',
      title: 'Help',
    });
    expect(script.nonce).toBe('abc123');
  });

  it('sets nothing it was not given', () => {
    void embed.loadHamnivo(options);
    expect({ ...(injectedScript() as HTMLScriptElement).dataset }).toEqual({ widgetId: WIDGET });
  });

  it('takes http, for a Hamnivo on your own computer', () => {
    void embed.loadHamnivo({ widgetId: WIDGET, chatUrl: 'http://localhost:3000' });
    expect((injectedScript() as HTMLScriptElement).src).toBe('http://localhost:3000/loader.js');
  });

  it('resolves with window.Hamnivo once the loader has started, and says the chat is loaded', async () => {
    const { api } = fakeLoader();
    const loading = embed.loadHamnivo(options);
    expect(embed.getHamnivoState().loaded).toBe(false);
    startLoader(api);
    await expect(loading).resolves.toBe(api);
    expect(embed.getHamnivoState().loaded).toBe(true);
  });

  it('gives the same chat to every call, and adds the script once', async () => {
    const { api } = fakeLoader();
    const first = embed.loadHamnivo(options);
    const second = embed.loadHamnivo(options);
    expect(second).toBe(first);
    expect(document.querySelectorAll('script')).toHaveLength(1);
    startLoader(api);
    await first;
    await expect(embed.loadHamnivo(options)).resolves.toBe(api);
    expect(document.querySelectorAll('script')).toHaveLength(1);
  });

  it('adds no script when the loader already runs on the page', async () => {
    const { api } = fakeLoader();
    (window as unknown as { Hamnivo?: unknown }).Hamnivo = api;
    await expect(embed.loadHamnivo(options)).resolves.toBe(api);
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(embed.getHamnivoState().loaded).toBe(true);
  });

  it('rejects, removes the script and lets a later call try again when the script cannot load', async () => {
    const loading = embed.loadHamnivo(options);
    failLoader();
    await expect(loading).rejects.toThrow(
      'The Hamnivo loader could not be loaded from https://chat.example.com/loader.js. Check the chat address.',
    );
    expect(document.querySelectorAll('script')).toHaveLength(0);

    const again = embed.loadHamnivo(options);
    expect(document.querySelectorAll('script')).toHaveLength(1);
    const { api } = fakeLoader();
    startLoader(api);
    await expect(again).resolves.toBe(api);
  });

  it('rejects when the script ran and the loader did not start, for example without a widget ID it accepts', async () => {
    const loading = embed.loadHamnivo(options);
    (injectedScript() as HTMLScriptElement).dispatchEvent(new Event('load'));
    await expect(loading).rejects.toThrow('ran but did not start');
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  it('refuses settings it can see are wrong, and adds nothing to the page', async () => {
    await expect(embed.loadHamnivo({ widgetId: '', chatUrl: CHAT })).rejects.toThrow(
      'widgetId is required',
    );
    for (const chatUrl of [
      '',
      'chat.example.com',
      'javascript:alert(1)',
      'ftp://chat.example.com',
    ]) {
      await expect(embed.loadHamnivo({ widgetId: WIDGET, chatUrl })).rejects.toThrow(
        'chatUrl must be a web address like https://chat.example.com',
      );
    }
    await expect(
      embed.loadHamnivo({ widgetId: WIDGET, chatUrl: CHAT, apiUrl: 'api.example.com' }),
    ).rejects.toThrow('apiUrl must be a web address');
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  it('warns when the page already has the chat for other settings, which the loader would ignore', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api } = fakeLoader();
    const loading = embed.loadHamnivo(options);
    void embed.loadHamnivo({ ...options, widgetId: 'wid_zzzzzzzzzzzzzzzzzzzzzzzzzz' });
    startLoader(api);
    await loading;
    void embed.loadHamnivo({ ...options, chatUrl: 'https://other.example.com' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain(`already on this page for ${WIDGET} at ${CHAT}`);
    warn.mockClear();
    void embed.loadHamnivo(options);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects on the server, where there is no page', async () => {
    vi.stubGlobal('document', undefined);
    await expect(embed.loadHamnivo(options)).rejects.toThrow(
      'loads in a browser, not on the server',
    );
  });
});

describe('the state of the chat', () => {
  async function loaded() {
    const loader = fakeLoader();
    const loading = embed.loadHamnivo(options);
    startLoader(loader.api);
    await loading;
    return loader;
  }

  it('starts as a page without the chat, and is the same object until something changes', () => {
    expect(embed.getHamnivoState()).toEqual({
      loaded: false,
      isOpen: false,
      unread: 0,
      verified: false,
    });
    expect(embed.getHamnivoState()).toBe(embed.getHamnivoState());
    expect(embed.getHamnivoState()).toBe(embed.INITIAL_STATE);
  });

  it('follows the window, the unread count and whether the visitor is verified', async () => {
    const { emit } = await loaded();
    const seen: unknown[] = [];
    embed.subscribeHamnivo(() => seen.push(embed.getHamnivoState()));
    emit('open');
    expect(embed.getHamnivoState().isOpen).toBe(true);
    emit('close');
    expect(embed.getHamnivoState().isOpen).toBe(false);
    emit('unread', { count: 3 });
    expect(embed.getHamnivoState().unread).toBe(3);
    emit('identity.changed', { verified: true });
    expect(embed.getHamnivoState().verified).toBe(true);
    emit('identity.changed', { verified: false });
    expect(embed.getHamnivoState().verified).toBe(false);
    expect(seen).toHaveLength(5);
  });

  it('reads the unread count as a whole number that is never negative', async () => {
    const { emit } = await loaded();
    for (const [sent, kept] of [
      [4.9, 4],
      [-2, 0],
      ['7', 7],
      ['many', 0],
      [undefined, 0],
    ] as const) {
      emit('unread', { count: sent });
      expect(embed.getHamnivoState().unread, String(sent)).toBe(kept);
    }
  });

  it('tells a listener only about real changes, and stops when it unsubscribes', async () => {
    const { emit } = await loaded();
    const listener = vi.fn();
    const stop = embed.subscribeHamnivo(listener);
    emit('unread', { count: 2 });
    emit('unread', { count: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    emit('unread', { count: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(embed.getHamnivoState().unread).toBe(5);
  });

  it('picks up a loader that was started by something else, such as the install code', () => {
    const { api, emit } = fakeLoader();
    (window as unknown as { Hamnivo?: unknown }).Hamnivo = api;
    const listener = vi.fn();
    embed.subscribeHamnivo(listener);
    expect(embed.getHamnivoState().loaded).toBe(true);
    emit('unread', { count: 1 });
    expect(embed.getHamnivoState().unread).toBe(1);
  });
});

describe('the controls', () => {
  it('open, close and toggle act on the window once it is on the page, and do nothing before', async () => {
    embed.hamnivoControls.open();
    embed.hamnivoControls.close();
    embed.hamnivoControls.toggle();
    const { api } = fakeLoader();
    const loading = embed.loadHamnivo(options);
    startLoader(api);
    await loading;
    embed.hamnivoControls.open();
    embed.hamnivoControls.toggle();
    embed.hamnivoControls.close();
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(api.toggle).toHaveBeenCalledTimes(1);
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  it('identify and reset wait for a chat that is loading, and pass on what they were given', async () => {
    const { api } = fakeLoader();
    const loading = embed.loadHamnivo(options);
    const identified = embed.hamnivoControls.identify('assertion-1');
    const reset = embed.hamnivoControls.reset();
    startLoader(api);
    await loading;
    await Promise.all([identified, reset]);
    expect(api.identify).toHaveBeenCalledWith('assertion-1');
    expect(api.reset).toHaveBeenCalledTimes(1);
  });

  it('identify and reset say so when nothing is putting the chat on the page', async () => {
    await expect(embed.hamnivoControls.identify('a')).rejects.toThrow('not on this page yet');
    await expect(embed.hamnivoControls.reset()).rejects.toThrow('Render <HamnivoChat /> first');
  });
});

describe('mountHamnivo', () => {
  const hidden = () => document.getElementById('hamnivo-embed-hidden');

  it('hides the chat when the last component is gone, closing it first, and shows it when one is back', async () => {
    const { api } = fakeLoader();
    const loading = embed.loadHamnivo(options);
    startLoader(api);
    await loading;

    const first = embed.mountHamnivo();
    const second = embed.mountHamnivo();
    expect(hidden()).toBeNull();
    first();
    expect(hidden()).toBeNull();
    second();
    expect(hidden()).not.toBeNull();
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(hidden()?.textContent).toBe(
      '[data-hamnivo-launcher],[data-hamnivo-frame],[data-hamnivo-prompt]{display:none!important}',
    );

    const back = embed.mountHamnivo();
    expect(hidden()).toBeNull();
    back();
    expect(hidden()).not.toBeNull();
  });

  it('counts each unmount once', () => {
    const one = embed.mountHamnivo();
    const two = embed.mountHamnivo();
    one();
    one();
    expect(hidden()).toBeNull();
    two();
    expect(hidden()).not.toBeNull();
  });

  it('gives the style the nonce of the policy, so a strict policy does not block it', async () => {
    const loading = embed.loadHamnivo({ ...options, nonce: 'n-1' });
    const { api } = fakeLoader();
    startLoader(api);
    await loading;
    embed.mountHamnivo()();
    expect(hidden()?.nonce).toBe('n-1');
  });
});

describe('syncHamnivoCustomer', () => {
  const FLAG = `hamnivo:embed:verified:${WIDGET}`;
  const customer = (key: string, assertion = `assertion-for-${key}`) => ({
    key,
    getAssertion: vi.fn(async () => assertion),
  });

  async function onPage() {
    const loader = fakeLoader();
    const sync = (who: ReturnType<typeof customer> | null) =>
      embed.syncHamnivoCustomer(options, () => who);
    return { ...loader, sync, started: () => startLoader(loader.api) };
  }

  it('identifies a signed-in customer with a fresh assertion, and remembers that this browser is verified', async () => {
    const { api, sync, started } = await onPage();
    const ana = customer('cus_1');
    const done = sync(ana);
    started();
    await done;
    expect(ana.getAssertion).toHaveBeenCalledTimes(1);
    expect(api.identify).toHaveBeenCalledWith('assertion-for-cus_1');
    expect(window.localStorage.getItem(FLAG)).toBe('1');
    expect(embed.getHamnivoState().verified).toBe(true);
  });

  it('signs the chat out when nobody is signed in and this browser was verified, once', async () => {
    window.localStorage.setItem(FLAG, '1');
    const { api, sync, started } = await onPage();
    const done = sync(null);
    started();
    await done;
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(FLAG)).toBeNull();
    await sync(null);
    expect(api.reset).toHaveBeenCalledTimes(1);
  });

  it('leaves an anonymous visitor alone', async () => {
    const { api, sync, started } = await onPage();
    const done = sync(null);
    started();
    await done;
    expect(api.reset).not.toHaveBeenCalled();
    expect(api.identify).not.toHaveBeenCalled();
  });

  it('identifies the next customer, and signs out when the customer goes', async () => {
    const { api, sync, started } = await onPage();
    const first = sync(customer('cus_1'));
    started();
    await first;
    await sync(customer('cus_2'));
    expect(api.identify.mock.calls.map((call) => call[0])).toEqual([
      'assertion-for-cus_1',
      'assertion-for-cus_2',
    ]);
    await sync(null);
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('never lets a sign-out overtake the sign-in before it', async () => {
    const { api, sync, started } = await onPage();
    let release: (assertion: string) => void = () => undefined;
    const slow = {
      key: 'cus_1',
      getAssertion: vi.fn(() => new Promise<string>((resolve) => (release = resolve))),
    };
    const signIn = sync(slow);
    started();
    await settle();
    const signOut = sync(null);
    await settle();
    expect(api.reset).not.toHaveBeenCalled();
    release('late-assertion');
    await Promise.all([signIn, signOut]);
    expect(api.identify).toHaveBeenCalledWith('late-assertion');
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(FLAG)).toBeNull();
    expect(embed.getHamnivoState().verified).toBe(false);
  });

  it('asks the customer as the page has them when the call runs, not as they were when it was made', async () => {
    const { api, started } = await onPage();
    const stale = customer('cus_1', 'stale-assertion');
    const fresh = customer('cus_1', 'fresh-assertion');
    let current = stale;
    const done = embed.syncHamnivoCustomer(options, () => current);
    current = fresh;
    started();
    await done;
    expect(stale.getAssertion).not.toHaveBeenCalled();
    expect(api.identify).toHaveBeenCalledWith('fresh-assertion');
  });

  it('skips a call that a newer one replaced before it started', async () => {
    const { api, sync, started } = await onPage();
    const a = customer('cus_a');
    const b = customer('cus_b');
    const first = sync(a);
    const second = sync(b);
    started();
    await Promise.all([first, second]);
    expect(a.getAssertion).not.toHaveBeenCalled();
    expect(b.getAssertion).toHaveBeenCalledTimes(1);
    expect(api.identify).toHaveBeenCalledTimes(1);
  });

  it('does nothing, and does not report it twice, when the chat cannot load', async () => {
    const done = embed.syncHamnivoCustomer(options, () => customer('cus_1'));
    await settle();
    failLoader();
    await expect(done).resolves.toBeUndefined();
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('rejects, and does not remember the browser as verified, when the assertion cannot be had', async () => {
    const { api, sync, started } = await onPage();
    const broken = {
      key: 'cus_1',
      getAssertion: vi.fn(async () => {
        throw new Error('The identity route refused.');
      }),
    };
    const done = sync(broken);
    started();
    await expect(done).rejects.toThrow('The identity route refused.');
    expect(api.identify).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(FLAG)).toBeNull();
    // The queue goes on after a failure.
    await sync(customer('cus_2'));
    expect(api.identify).toHaveBeenCalledWith('assertion-for-cus_2');
  });

  it('does not remember a customer the chat refused', async () => {
    const { api, sync, started } = await onPage();
    api.identify.mockRejectedValueOnce(new Error('identity_rejected'));
    const done = sync(customer('cus_1'));
    started();
    await expect(done).rejects.toThrow('identity_rejected');
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('forgets the flag even when the chat cannot sign out, and says so', async () => {
    window.localStorage.setItem(FLAG, '1');
    const { api, sync, started } = await onPage();
    api.reset.mockRejectedValueOnce(new Error('timeout'));
    const done = sync(null);
    started();
    await expect(done).rejects.toThrow('timeout');
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('still identifies where the browser keeps no storage', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { api, sync, started } = await onPage();
    const done = sync(customer('cus_1'));
    started();
    await done;
    expect(api.identify).toHaveBeenCalledTimes(1);
    await sync(null);
    expect(api.reset).not.toHaveBeenCalled();
  });
});
