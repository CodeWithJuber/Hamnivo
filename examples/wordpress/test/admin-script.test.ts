// @vitest-environment jsdom
/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The settings page's script, run the way WordPress runs it. */
const script = readFileSync(
  join(import.meta.dirname, '../../../integrations/wordpress/hamnivo-chat/assets/admin.js'),
  'utf8',
);
const run = () => new Function(script)();
const host = window as unknown as { hamnivoChatAdmin?: Record<string, unknown> };

const strings = {
  testing: 'Testing…',
  allOk: 'Everything works.',
  notOk: 'Something needs a look.',
  failed: 'The test could not run.',
  ok: 'Works',
  problem: 'Problem',
};

function showPage() {
  document.body.innerHTML = `
    <textarea id="hamnivo_chat_install_code">&lt;script data-widget-id="wid_x"&gt;</textarea>
    <input id="hamnivo_chat_widget_id" value="wid_01j9zk7w3xq8r4t2v6m5n1p0ce" />
    <input id="hamnivo_chat_chat_url" value="https://chat.example.com" />
    <input id="hamnivo_chat_api_url" value="https://api.example.com" />
    <button type="button" id="hamnivo-chat-test">Test connection</button>
    <span id="hamnivo-chat-test-status"></span>
    <ul id="hamnivo-chat-test-results"></ul>`;
  host.hamnivoChatAdmin = {
    ajaxUrl: '/wp-admin/admin-ajax.php',
    action: 'hamnivo_chat_test',
    nonce: 'nonce-abc',
    strings,
  };
}

function answer(payload: unknown) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ json: async () => payload }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const button = () => document.getElementById('hamnivo-chat-test') as HTMLButtonElement;
const status = () => document.getElementById('hamnivo-chat-test-status')?.textContent;
const items = () => [...document.querySelectorAll('#hamnivo-chat-test-results li')];

beforeEach(showPage);
afterEach(() => {
  delete host.hamnivoChatAdmin;
  vi.unstubAllGlobals();
});

describe('assets/admin.js', () => {
  it('sends what is typed in the form, with the nonce, to the AJAX handler', async () => {
    const fetch = answer({ success: true, data: { ok: true, checks: [] } });
    run();
    button().click();
    await vi.waitFor(() => expect(status()).toBe(strings.allOk));

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/wp-admin/admin-ajax.php');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    const body = init.body as FormData;
    expect(Object.fromEntries(body.entries())).toEqual({
      action: 'hamnivo_chat_test',
      nonce: 'nonce-abc',
      install_code: '<script data-widget-id="wid_x">',
      widget_id: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chat_url: 'https://chat.example.com',
      api_url: 'https://api.example.com',
    });
  });

  it('shows each check with its result in words, and says so when something needs a look', async () => {
    answer({
      success: true,
      data: {
        ok: false,
        checks: [
          { ok: true, label: 'Widget ID', detail: 'The widget ID has the right shape.' },
          { ok: false, label: 'Chat address', detail: 'Check the address.' },
        ],
      },
    });
    run();
    button().click();
    await vi.waitFor(() => expect(status()).toBe(strings.notOk));

    expect(items().map((item) => item.textContent)).toEqual([
      'Works: Widget ID. The widget ID has the right shape.',
      'Problem: Chat address. Check the address.',
    ]);
    expect(items().map((item) => item.className)).toEqual([
      'hamnivo-chat-ok',
      'hamnivo-chat-problem',
    ]);
  });

  it('writes what the server says as text, never as HTML', async () => {
    answer({
      success: true,
      data: {
        ok: false,
        checks: [
          {
            ok: false,
            label: '<img src=x onerror=alert(1)>',
            detail: '<b>bold</b><script>alert(2)</script>',
          },
        ],
      },
    });
    run();
    button().click();
    await vi.waitFor(() => expect(items()).toHaveLength(1));

    expect(
      document.querySelector(
        '#hamnivo-chat-test-results img, #hamnivo-chat-test-results b, #hamnivo-chat-test-results script',
      ),
    ).toBeNull();
    expect(items()[0]?.textContent).toContain('<b>bold</b>');
  });

  it('keeps the button off while the test runs, and on again after', async () => {
    let finish: (value: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    run();
    button().click();
    expect(button().disabled).toBe(true);
    expect(status()).toBe(strings.testing);

    finish({ json: async () => ({ success: true, data: { ok: true, checks: [] } }) });
    await vi.waitFor(() => expect(button().disabled).toBe(false));
  });

  it('says so when the request fails or is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    run();
    button().click();
    await vi.waitFor(() => expect(status()).toBe(strings.failed));
    expect(button().disabled).toBe(false);

    answer({ success: false, data: { message: 'You are not allowed to do this.' } });
    button().click();
    await vi.waitFor(() => expect(status()).toBe(strings.failed));
  });

  it('does nothing on a page that is not the settings page', () => {
    document.body.innerHTML = '<p>Another page</p>';
    expect(() => run()).not.toThrow();
  });
});
