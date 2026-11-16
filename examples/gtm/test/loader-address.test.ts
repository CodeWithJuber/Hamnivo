// @vitest-environment jsdom
/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTemplate, section } from './sandbox.js';

/**
 * The built loader (@hamnivo/widget-loader, built before these tests run) reading its settings
 * from the address of its own script, which is all that Google Tag Manager's injectScript can
 * pass. The last test joins the two halves: the address the template builds is the address the
 * loader is given.
 */
const loader = readFileSync(
  createRequire(import.meta.url).resolve('@hamnivo/widget-loader/loader.js'),
  'utf8',
);
const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
const host = window as unknown as { Hamnivo?: { loaded: boolean; open(): void } };

/** Where the loader puts the launcher: in a shadow root, apart from the page's own styles. */
const root = () => document.querySelector<HTMLElement>('[data-hamnivo-root]');
const launcher = () =>
  root()?.shadowRoot?.querySelector<HTMLElement>('[data-hamnivo-launcher]') ?? null;

/** Runs the loader as the page would, for a script with this address and these data attributes. */
function runLoader(src: string, attributes: Record<string, string> = {}) {
  const script = document.createElement('script');
  script.src = src;
  for (const [name, value] of Object.entries(attributes))
    script.setAttribute(`data-${name}`, value);
  Object.defineProperty(document, 'currentScript', { value: script, configurable: true });
  try {
    new Function(loader)();
  } finally {
    Reflect.deleteProperty(document, 'currentScript');
  }
}

/** Opens the chat and returns the address of the frame the loader made, as URL parts. */
function openFrame() {
  host.Hamnivo?.open();
  const frame = document.querySelector<HTMLIFrameElement>('iframe[data-hamnivo-frame]');
  if (!frame) throw new Error('the loader made no frame');
  const url = new URL(frame.src);
  return { origin: url.origin, params: url.searchParams };
}

let fetched: string[] = [];

beforeEach(() => {
  fetched = [];
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url);
      return { ok: false };
    }),
  );
  // jsdom has no matchMedia, which the loader asks when it places the chat window.
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  // Each test starts its own loader; the one before is taken off the page, or it would put its
  // launcher and frame back into the next test's page, as it does for a page that replaces <body>.
  (host.Hamnivo as { destroy?: () => void } | undefined)?.destroy?.();
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'Hamnivo');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the loader, given its settings in its address', () => {
  it('starts with the widget ID, and opens the chat app on the origin of its own address', () => {
    runLoader(`https://chat.example.com/loader.js?widgetId=${WIDGET}`);
    expect(host.Hamnivo?.loaded).toBe(true);
    expect(launcher()).not.toBeNull();
    const frame = openFrame();
    expect(frame.origin).toBe('https://chat.example.com');
    expect(frame.params.get('widgetId')).toBe(WIDGET);
    expect(frame.params.has('api')).toBe(false);
  });

  it("reads the API address from the address, decoded, and asks it for the brand's launcher", async () => {
    runLoader(
      `https://chat.example.com/loader.js?widgetId=${WIDGET}&api=${encodeURIComponent('https://api.example.com/')}`,
    );
    await vi.waitFor(() => expect(launcher()).not.toBeNull());
    // The launcher is the only GET; the visit report the loader also sends (POST) is another test's.
    expect(fetched.filter((url) => url.includes('/v1/widget/launcher'))).toEqual([
      `https://api.example.com/v1/widget/launcher?widgetId=${WIDGET}`,
    ]);
    expect(fetched.every((url) => url.startsWith('https://api.example.com/'))).toBe(true);
    expect(openFrame().params.get('api')).toBe('https://api.example.com/');
  });

  it('takes the other settings the same way, with the names of the data attributes', () => {
    runLoader(
      `https://chat.example.com/loader.js?widgetId=${WIDGET}&position=bottom-left&color=%23ff0000`,
    );
    // The corner belongs to the root; the colour to the button in it.
    expect(root()?.style.left).toBe('20px');
    expect(launcher()?.style.background).toMatch(/#ff0000|rgb\(255, 0, 0\)/);
  });

  it('lets a data attribute win over the same setting in the address', () => {
    runLoader(
      `https://chat.example.com/loader.js?widgetId=wid_aaaaaaaaaaaaaaaaaaaaaaaaaa&position=bottom-left`,
      {
        'widget-id': WIDGET,
        position: 'bottom-right',
      },
    );
    expect(openFrame().params.get('widgetId')).toBe(WIDGET);
    expect(root()?.style.right).toBe('20px');
  });

  it('still works with data attributes alone, as the install code uses it', () => {
    runLoader('https://chat.example.com/loader.js', { 'widget-id': WIDGET });
    expect(host.Hamnivo?.loaded).toBe(true);
    expect(openFrame().params.get('widgetId')).toBe(WIDGET);
  });

  it('says what is missing when neither the address nor an attribute has a widget ID', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runLoader('https://chat.example.com/loader.js?api=https%3A%2F%2Fapi.example.com');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('data-widget-id'));
    expect(host.Hamnivo).toBeUndefined();
    expect(root()).toBeNull();
  });

  it('does not fail on an address it cannot read', () => {
    expect(() => runLoader('', { 'widget-id': WIDGET })).not.toThrow();
    expect(host.Hamnivo?.loaded).toBe(true);
  });
});

describe('the template and the loader together', () => {
  it('start the chat from the address the template builds', async () => {
    const code = section('SANDBOXED_JS_FOR_WEB_TEMPLATE');
    const result = runTemplate(code, {
      widgetId: WIDGET,
      chatUrl: 'https://chat.example.com/loader.js',
      apiUrl: 'https://api.example.com',
    });
    const [address] = result.injected;
    expect(result.success).toBe(1);
    runLoader(address as string);
    expect(host.Hamnivo?.loaded).toBe(true);
    // The chat opens in the brand's layout, so it waits for the launcher's settings.
    await vi.waitFor(() => expect(launcher()).not.toBeNull());
    const frame = openFrame();
    expect(frame.origin).toBe('https://chat.example.com');
    expect(frame.params.get('widgetId')).toBe(WIDGET);
    expect(frame.params.get('api')).toBe('https://api.example.com');
  });
});
