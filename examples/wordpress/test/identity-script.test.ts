// @vitest-environment jsdom
/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The plugin's browser script, run the way the page runs it. */
const script = readFileSync(
  join(import.meta.dirname, '../../../integrations/wordpress/hamnivo-chat/assets/identity.js'),
  'utf8',
);
const run = () => new Function(script)();

type Hamnivo = { identify: (assertion: string) => Promise<void>; reset: () => Promise<void> };
const host = window as unknown as {
  Hamnivo?: Hamnivo;
  HamnivoChatIdentity?: Record<string, unknown>;
};
const FLAG = 'hamnivo-chat:verified';

function configure(loggedIn: boolean) {
  host.HamnivoChatIdentity = {
    loggedIn,
    endpoint: 'https://shop.example.com/wp-json/hamnivo-chat/v1/identity',
    nonce: loggedIn ? 'nonce-123' : '',
  };
}

function stubHamnivo(reset: () => Promise<void> = async () => {}) {
  return { identify: vi.fn(async (_assertion: string) => {}), reset: vi.fn(reset) };
}

function stubRoute(status = 200) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status === 200,
    status,
    json: async () => ({ assertion: 'signed-assertion' }),
  }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

// Each run of the script listens on the document, as it does once per real page. Take those
// listeners away after each test, so that one test's script does not answer the next test's click.
const listeners: [string, EventListenerOrEventListenerObject][] = [];

beforeEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      listeners.push([type, listener]);
      add(type, listener, options);
    },
  );
});

afterEach(() => {
  for (const [type, listener] of listeners.splice(0)) document.removeEventListener(type, listener);
  delete host.Hamnivo;
  delete host.HamnivoChatIdentity;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('assets/identity.js, signed in', () => {
  it('asks the site for a fresh assertion with the REST nonce, and passes it to the chat', async () => {
    configure(true);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const fetch = stubRoute();
    run();
    await vi.waitFor(() => expect(hamnivo.identify).toHaveBeenCalledWith('signed-assertion'));
    expect(fetch).toHaveBeenCalledWith(
      'https://shop.example.com/wp-json/hamnivo-chat/v1/identity',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: expect.objectContaining({ 'X-WP-Nonce': 'nonce-123' }),
      }),
    );
    await vi.waitFor(() => expect(window.localStorage.getItem(FLAG)).toBe('1'));
  });

  it('waits for the async loader, which may run after this script', async () => {
    vi.useFakeTimers();
    configure(true);
    stubRoute();
    run();
    await vi.advanceTimersByTimeAsync(350);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    await vi.advanceTimersByTimeAsync(200);
    expect(hamnivo.identify).toHaveBeenCalledTimes(1);
  });

  it('gives up after ten seconds when the loader never runs, and asks the site for nothing', async () => {
    vi.useFakeTimers();
    configure(true);
    const fetch = stubRoute();
    run();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not identify, and says why, when the site refuses', async () => {
    configure(true);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    stubRoute(401);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    run();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(hamnivo.identify).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('does not remember a customer the chat refused', async () => {
    configure(true);
    const hamnivo = stubHamnivo();
    hamnivo.identify.mockRejectedValue(new Error('identity_rejected'));
    host.Hamnivo = hamnivo;
    stubRoute();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    run();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('still identifies where the browser has no storage', async () => {
    configure(true);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    stubRoute();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    run();
    await vi.waitFor(() => expect(hamnivo.identify).toHaveBeenCalledTimes(1));
  });
});

describe('assets/identity.js, signed out', () => {
  it('ends a verified chat left in this browser, once, so the next person starts anonymous', async () => {
    configure(false);
    window.localStorage.setItem(FLAG, '1');
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const fetch = stubRoute();
    run();
    await vi.waitFor(() => expect(hamnivo.reset).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(window.localStorage.getItem(FLAG)).toBeNull());
    expect(fetch).not.toHaveBeenCalled();
    expect(hamnivo.identify).not.toHaveBeenCalled();
  });

  it('leaves an anonymous visitor alone', async () => {
    configure(false);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const fetch = stubRoute();
    run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hamnivo.reset).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forgets the flag even when the chat cannot sign out', async () => {
    configure(false);
    window.localStorage.setItem(FLAG, '1');
    const hamnivo = stubHamnivo(async () => {
      throw new Error('reset_incomplete');
    });
    host.Hamnivo = hamnivo;
    run();
    await vi.waitFor(() => expect(window.localStorage.getItem(FLAG)).toBeNull());
  });
});

describe('assets/identity.js, log out links', () => {
  function addLink(href: string) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = 'Log out';
    // jsdom cannot navigate. The second click of a replayed link is what a browser would follow.
    link.addEventListener('click', (event) => {
      if (!event.defaultPrevented) event.preventDefault();
    });
    document.body.appendChild(link);
    return link;
  }

  it('signs the chat out first, then follows the link', async () => {
    configure(true);
    stubRoute();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const link = addLink('/wp-login.php?action=logout&_wpnonce=abc');
    const dispatched = vi.fn();
    document.addEventListener('click', dispatched);
    run();

    link.click();
    expect(hamnivo.reset).toHaveBeenCalledTimes(1);
    // The first click was stopped. After the reset, the link is clicked again.
    await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(2));
  });

  it('also catches the log out links of WooCommerce, with or without pretty permalinks', async () => {
    configure(true);
    stubRoute();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const pretty = addLink('/my-account/customer-logout/?_wpnonce=abc');
    const prettyNoSlash = addLink('/shop/account/customer-logout?_wpnonce=abc');
    const plain = addLink('/?page_id=9&customer-logout=true&_wpnonce=abc');
    run();

    pretty.click();
    await vi.waitFor(() => expect(hamnivo.reset).toHaveBeenCalledTimes(1));
    prettyNoSlash.click();
    await vi.waitFor(() => expect(hamnivo.reset).toHaveBeenCalledTimes(2));
    plain.click();
    await vi.waitFor(() => expect(hamnivo.reset).toHaveBeenCalledTimes(3));
  });

  it('does not take a page that only has customer-logout in its name for a log out link', async () => {
    configure(true);
    stubRoute();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const other = addLink('/blog/why-customer-logout-matters/');
    run();
    other.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hamnivo.reset).not.toHaveBeenCalled();
  });

  it('follows the link after three seconds even when the chat never answers', async () => {
    vi.useFakeTimers();
    configure(true);
    stubRoute();
    const hamnivo = stubHamnivo(() => new Promise<void>(() => {}));
    host.Hamnivo = hamnivo;
    const link = addLink('/my-account/?customer-logout=true&_wpnonce=abc');
    const dispatched = vi.fn();
    document.addEventListener('click', dispatched);
    run();
    await vi.advanceTimersByTimeAsync(0);

    link.click();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(dispatched).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatched).toHaveBeenCalledTimes(2);
  });

  it('ignores other links, other websites and clicks that open a new tab', async () => {
    configure(true);
    stubRoute();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const plain = addLink('/shop/');
    const other = addLink('https://elsewhere.example/wp-login.php?action=logout');
    const logout = addLink('/wp-login.php?action=logout&_wpnonce=abc');
    run();

    plain.click();
    other.click();
    logout.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    logout.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 }));
    expect(hamnivo.reset).not.toHaveBeenCalled();
  });

  it('is not started when the page has no configuration', async () => {
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const fetch = stubRoute();
    expect(() => run()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
  });
});
