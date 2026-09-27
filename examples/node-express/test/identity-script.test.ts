// @vitest-environment jsdom
/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '../src/page.js';
import { USERS } from '../src/users.js';

/** The browser script, run the way the page runs it. */
const script = readFileSync(join(import.meta.dirname, '../public/identity.js'), 'utf8');
const run = () => new Function(script)();

type Hamnivo = { identify: (assertion: string) => Promise<void>; reset: () => Promise<void> };
const host = window as unknown as { Hamnivo?: Hamnivo };

function showPage(signedIn: boolean) {
  const html = renderPage({
    widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
    widgetOrigin: 'https://chat.example.com',
    api: 'https://api.example.com',
    user: signedIn ? USERS[0] : undefined,
  });
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));
}

function stubHamnivo(reset: () => Promise<void> = async () => {}) {
  const hamnivo = { identify: vi.fn(async (_assertion: string) => {}), reset: vi.fn(reset) };
  return hamnivo;
}

function stubIdentityRoute(status = 200) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status === 200,
    json: async () => ({ assertion: 'signed-assertion' }),
  }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  delete host.Hamnivo;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('public/identity.js', () => {
  it('passes a fresh assertion to the chat when the customer is signed in', async () => {
    showPage(true);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const fetch = stubIdentityRoute();
    run();
    await vi.waitFor(() => expect(hamnivo.identify).toHaveBeenCalledWith('signed-assertion'));
    expect(fetch).toHaveBeenCalledWith('/hamnivo/identity', { credentials: 'same-origin' });
  });

  it('waits for the async loader before it identifies', async () => {
    showPage(true);
    stubIdentityRoute();
    run();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    document.querySelector('script[data-widget-id]')?.dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(hamnivo.identify).toHaveBeenCalledTimes(1));
  });

  it('does nothing for a signed-out visitor, or when the website refuses', async () => {
    showPage(false);
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const fetch = stubIdentityRoute();
    run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();

    showPage(true);
    stubIdentityRoute(401);
    run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hamnivo.identify).not.toHaveBeenCalled();
  });

  it('resets the chat before signing out', async () => {
    showPage(true);
    stubIdentityRoute();
    const hamnivo = stubHamnivo();
    host.Hamnivo = hamnivo;
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    run();
    document.getElementById('sign-out')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(hamnivo.reset).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });

  it('signs out within 3 seconds even when the chat never answers', async () => {
    vi.useFakeTimers();
    showPage(true);
    stubIdentityRoute();
    const hamnivo = stubHamnivo(() => new Promise<void>(() => {}));
    host.Hamnivo = hamnivo;
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    run();
    document.getElementById('sign-out')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
