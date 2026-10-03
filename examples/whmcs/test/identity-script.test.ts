// @vitest-environment jsdom
/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The addon's browser script, run the way the client area page runs it. */
const script = readFileSync(
  join(
    import.meta.dirname,
    '../../../integrations/whmcs/modules/addons/hamnivo/assets/identity.js',
  ),
  'utf8',
);
const run = () => new Function(script)();

type Hamnivo = {
  identify: (assertion: string) => Promise<void>;
  reset: () => Promise<void>;
  setContext?: (context: unknown) => void;
};
const host = window as unknown as {
  Hamnivo?: Hamnivo;
  HamnivoWhmcs?: Record<string, unknown>;
};
const FLAG = 'hamnivo-whmcs:verified';
const ENDPOINT = 'https://billing.example.com/index.php?m=hamnivo&a=identity';

function configure(loggedIn: boolean) {
  host.HamnivoWhmcs = { loggedIn, endpoint: ENDPOINT };
}

function stubHamnivo(reset: () => Promise<void> = async () => {}) {
  return { identify: vi.fn(async (_assertion: string) => {}), reset: vi.fn(reset) };
}

function stubEndpoint(status = 200, body: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status === 200,
    status,
    json: async () => ({ assertion: 'signed-assertion', ...body }),
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
  delete host.HamnivoWhmcs;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('assets/identity.js, signed in', () => {
  it('asks WHMCS for a fresh assertion as the page itself, and passes it to the chat', async () => {
    configure(true);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const fetch = stubEndpoint();
    run();
    await vi.waitFor(() => expect(hamnivo.identify).toHaveBeenCalledWith('signed-assertion'));
    expect(fetch).toHaveBeenCalledWith(
      ENDPOINT,
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest' }),
      }),
    );
    await vi.waitFor(() => expect(window.localStorage.getItem(FLAG)).toBe('1'));
  });

  it('sends nothing about the client: the address is the only input', async () => {
    configure(true);
    host.Hamnivo = stubHamnivo();
    const fetch = stubEndpoint();
    run();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.body).toBeUndefined();
  });

  it('waits for the async loader, which may run after this script', async () => {
    vi.useFakeTimers();
    configure(true);
    stubEndpoint();
    run();
    await vi.advanceTimersByTimeAsync(350);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    await vi.advanceTimersByTimeAsync(200);
    expect(hamnivo.identify).toHaveBeenCalledTimes(1);
  });

  it('gives up after ten seconds when the loader never runs, and asks WHMCS for nothing', async () => {
    vi.useFakeTimers();
    configure(true);
    const fetch = stubEndpoint();
    run();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not identify, and says why, when WHMCS refuses', async () => {
    configure(true);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    stubEndpoint(401);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    run();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(hamnivo.identify).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('does not remember a client the chat refused', async () => {
    configure(true);
    const hamnivo = stubHamnivo();
    hamnivo.identify.mockRejectedValue(new Error('identity_rejected'));
    host.Hamnivo = hamnivo;
    stubEndpoint();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    run();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('still identifies where the browser has no storage', async () => {
    configure(true);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    stubEndpoint();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    run();
    await vi.waitFor(() => expect(hamnivo.identify).toHaveBeenCalledTimes(1));
  });
});

describe('assets/identity.js, product names', () => {
  const context = { pageType: 'client-area', references: { product1: 'Business Hosting' } };

  it('passes the context on, after the client is identified, when the chat can take it', async () => {
    configure(true);
    const hamnivo = { ...stubHamnivo(), setContext: vi.fn() };
    host.Hamnivo = hamnivo;
    stubEndpoint(200, { context });
    run();
    await vi.waitFor(() => expect(hamnivo.setContext).toHaveBeenCalledWith(context));
    expect(hamnivo.identify.mock.invocationCallOrder[0]).toBeLessThan(
      hamnivo.setContext.mock.invocationCallOrder[0] as number,
    );
  });

  it('identifies all the same when the chat has no way to take context yet', async () => {
    configure(true);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    stubEndpoint(200, { context });
    run();
    await vi.waitFor(() => expect(window.localStorage.getItem(FLAG)).toBe('1'));
    expect(hamnivo.identify).toHaveBeenCalledTimes(1);
  });

  it('passes nothing on when WHMCS sent no context', async () => {
    configure(true);
    const hamnivo = { ...stubHamnivo(), setContext: vi.fn() };
    host.Hamnivo = hamnivo;
    stubEndpoint();
    run();
    await vi.waitFor(() => expect(window.localStorage.getItem(FLAG)).toBe('1'));
    expect(hamnivo.setContext).not.toHaveBeenCalled();
  });
});

describe('assets/identity.js, signed out', () => {
  it('ends a verified chat left in this browser, once, so the next person starts anonymous', async () => {
    configure(false);
    window.localStorage.setItem(FLAG, '1');
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const fetch = stubEndpoint();
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
    const fetch = stubEndpoint();
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
    stubEndpoint();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const link = addLink('/logout.php');
    const dispatched = vi.fn();
    document.addEventListener('click', dispatched);
    run();

    link.click();
    expect(hamnivo.reset).toHaveBeenCalledTimes(1);
    // The first click was stopped. After the reset, the link is clicked again.
    await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(2));
  });

  it('also catches the route form of the log out link, in a folder or with a trailing slash', async () => {
    configure(true);
    stubEndpoint();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const folder = addLink('/billing/logout.php');
    const path = addLink('/billing/logout/');
    const route = addLink('/index.php?rp=/logout');
    run();

    folder.click();
    await vi.waitFor(() => expect(hamnivo.reset).toHaveBeenCalledTimes(1));
    path.click();
    await vi.waitFor(() => expect(hamnivo.reset).toHaveBeenCalledTimes(2));
    route.click();
    await vi.waitFor(() => expect(hamnivo.reset).toHaveBeenCalledTimes(3));
  });

  it('does not take a page that only has logout in its name for a log out link', async () => {
    configure(true);
    stubEndpoint();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const blog = addLink('/blog/why-logout-matters/');
    const policy = addLink('/logout-policy.php');
    const route = addLink('/index.php?rp=/knowledgebase/logout-problems');
    run();
    blog.click();
    policy.click();
    route.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hamnivo.reset).not.toHaveBeenCalled();
  });

  it('follows the link after three seconds even when the chat never answers', async () => {
    vi.useFakeTimers();
    configure(true);
    stubEndpoint();
    const hamnivo = stubHamnivo(() => new Promise<void>(() => {}));
    host.Hamnivo = hamnivo;
    const link = addLink('/logout.php');
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
    stubEndpoint();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const plain = addLink('/clientarea.php');
    const other = addLink('https://elsewhere.example/logout.php');
    const logout = addLink('/logout.php');
    run();

    plain.click();
    other.click();
    logout.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    logout.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 }));
    expect(hamnivo.reset).not.toHaveBeenCalled();
  });

  it('does nothing about log out links for a visitor who is signed out', async () => {
    configure(false);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const link = addLink('/logout.php');
    run();
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hamnivo.reset).not.toHaveBeenCalled();
  });

  it('is not started when the page has no configuration', async () => {
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const fetch = stubEndpoint();
    expect(() => run()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
  });
});
