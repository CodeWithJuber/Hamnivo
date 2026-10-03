// @vitest-environment jsdom
/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Liquid } from 'liquidjs';
import { describe, expect, it } from 'vitest';

/**
 * The app embed block, rendered with the settings a merchant could type. Shopify renders it with
 * its own Liquid (Ruby). This test renders it with LiquidJS, which runs the same language, so the
 * block uses only tags and filters that both have (the last describe checks that). Shopify's Theme
 * Check, the check that `shopify app build` runs, was run on the extension too: see
 * integrations/shopify/README.md.
 */
const extension = join(
  import.meta.dirname,
  '../../../integrations/shopify/extensions/hamnivo-chat',
);
const source = readFileSync(join(extension, 'blocks/hamnivo-chat.liquid'), 'utf8');
// Shopify reads the schema tag. LiquidJS does not know it, so it renders what comes before it.
const template = source.slice(0, source.indexOf('{% schema %}'));
const engine = new Liquid();

const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
const render = (settings: Record<string, unknown>) =>
  engine.parseAndRender(template, { block: { settings } });

type Loader = {
  src: string;
  widgetId: string;
  api: string | null;
  async: boolean;
  attributes: string[];
};

/** The script tags in rendered HTML, read by a real HTML parser. */
async function scripts(settings: Record<string, unknown>): Promise<Loader[]> {
  const holder = document.createElement('div');
  holder.innerHTML = await render(settings);
  return [...holder.querySelectorAll('script')].map((script) => ({
    src: script.getAttribute('src') ?? '',
    widgetId: script.getAttribute('data-widget-id') ?? '',
    api: script.getAttribute('data-api'),
    async: script.hasAttribute('async'),
    attributes: script.getAttributeNames().sort(),
  }));
}

const good = { widget_id: WIDGET, chat_address: 'https://chat.example.com' };

describe('the loader', () => {
  it('is one async script from the chat address, with the widget ID and the API address', async () => {
    const found = await scripts({ ...good, api_address: 'https://api.example.com' });
    expect(found).toEqual([
      {
        src: 'https://chat.example.com/loader.js',
        widgetId: WIDGET,
        api: 'https://api.example.com',
        async: true,
        attributes: ['async', 'data-api', 'data-widget-id', 'src'],
      },
    ]);
  });

  it('leaves out data-api when there is no API address', async () => {
    const [loader] = await scripts(good);
    expect(loader?.api).toBeNull();
    expect(loader?.attributes).toEqual(['async', 'data-widget-id', 'src']);
  });

  it('is the same HTML as the install code of Hamnivo Studio', async () => {
    const html = (await render({ ...good, api_address: 'https://api.example.com' }))
      .replace(/\s+/g, ' ')
      .trim();
    expect(html).toBe(
      `<script async src="https://chat.example.com/loader.js" data-widget-id="${WIDGET}" data-api="https://api.example.com" ></script>`,
    );
  });

  it('keeps only the origin of the chat address, because the loader finds the chat app there', async () => {
    for (const address of [
      'https://chat.example.com/',
      'https://chat.example.com//',
      'https://chat.example.com/some/page?x=1#top',
      'https://chat.example.com/loader.js',
    ]) {
      const [loader] = await scripts({ ...good, chat_address: address });
      expect(loader?.src, address).toBe('https://chat.example.com/loader.js');
    }
  });

  it('takes http and a port, for a Hamnivo that runs on your own computer', async () => {
    const [loader] = await scripts({ ...good, chat_address: 'http://localhost:3000' });
    expect(loader?.src).toBe('http://localhost:3000/loader.js');
  });

  it('keeps the path of the API address and drops its trailing slashes', async () => {
    for (const [given, kept] of [
      ['https://api.example.com/', 'https://api.example.com'],
      ['https://api.example.com//', 'https://api.example.com'],
      ['https://example.com/api/v1/', 'https://example.com/api/v1'],
      ['http://localhost:4000', 'http://localhost:4000'],
    ] as const) {
      const [loader] = await scripts({ ...good, api_address: given });
      expect(loader?.api, given).toBe(kept);
    }
  });

  it('trims the spaces that a copy and paste brings along', async () => {
    const [loader] = await scripts({
      widget_id: `  ${WIDGET}\n`,
      chat_address: ' https://chat.example.com ',
      api_address: '\thttps://api.example.com/ ',
    });
    expect(loader?.widgetId).toBe(WIDGET);
    expect(loader?.src).toBe('https://chat.example.com/loader.js');
    expect(loader?.api).toBe('https://api.example.com');
  });

  it('still shows the chat when only the optional API address is wrong, and drops that address', async () => {
    for (const api of [
      'not a url',
      'api.example.com',
      'ftp://api.example.com',
      'javascript:alert(1)',
    ]) {
      const [loader] = await scripts({ ...good, api_address: api });
      expect(loader?.src, api).toBe('https://chat.example.com/loader.js');
      expect(loader?.api, api).toBeNull();
    }
  });
});

describe('what it refuses to put on a page', () => {
  async function expectNothing(settings: Record<string, unknown>, why: string) {
    expect(await scripts(settings), why).toEqual([]);
    // The page gets a comment that tells a developer who looks at the source what to fix.
    expect(await render(settings), why).toContain('<!-- Hamnivo Chat is on, but');
  }

  it('adds no script until the widget ID and the chat address are set', async () => {
    await expectNothing({}, 'nothing set');
    await expectNothing({ widget_id: '', chat_address: '' }, 'empty');
    await expectNothing({ widget_id: WIDGET }, 'no chat address');
    await expectNothing({ chat_address: 'https://chat.example.com' }, 'no widget ID');
  });

  it('refuses a widget ID that is not wid_ and 26 letters and digits long', async () => {
    for (const id of [
      'wid_',
      'wid_01j9zk7w3xq8r4t2v6m5n1p0c',
      'wid_01j9zk7w3xq8r4t2v6m5n1p0cee',
      'abc_01j9zk7w3xq8r4t2v6m5n1p0ce',
      '01j9zk7w3xq8r4t2v6m5n1p0cewid_',
      'wid_01j9zk7w3xq8r4t2v6m5 1p0ce',
      'brd_01j9zk7w3xq8r4t2v6m5n1p0ce',
    ]) {
      await expectNothing({ ...good, widget_id: id }, id);
    }
  });

  it('refuses a chat address that is not a web address', async () => {
    for (const address of [
      'chat.example.com',
      '//chat.example.com',
      'https:/chat.example.com',
      'https://',
      'https:///loader.js',
      'ftp://chat.example.com',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://chat example.com',
      'https://chat.example.com@evil.example',
      'not a url',
    ]) {
      await expectNothing({ ...good, chat_address: address }, address);
    }
  });

  it('copes with settings that are missing or not text', async () => {
    await expectNothing({ widget_id: null, chat_address: undefined }, 'null');
    await expectNothing({ widget_id: 5, chat_address: 7 }, 'numbers');
  });
});

describe('escaping', () => {
  // Values that try to close the attribute and add an element. They hold no space, because a space
  // makes the block refuse the value before it is written at all (tested above).
  const attacks = ['"><svg/onload=alert(1)>', `'"><script>alert(2)</script>`];

  it('cannot be broken out of by a quote or a tag in any setting', async () => {
    for (const attack of attacks) {
      const id = `wid_${(attack + 'z'.repeat(26)).slice(0, 26)}`;
      expect(id).toHaveLength(30);
      const html = await render({
        widget_id: id,
        chat_address: `https://chat.example.com${attack}`,
        api_address: `https://api.example.com${attack}`,
      });
      // However the values were read, the only element is the loader, with its four attributes.
      const holder = document.createElement('div');
      holder.innerHTML = html;
      expect(holder.querySelectorAll('svg'), attack).toHaveLength(0);
      const found = [...holder.querySelectorAll('script')];
      expect(found, attack).toHaveLength(1);
      expect(found[0]?.getAttributeNames().sort(), attack).toEqual([
        'async',
        'data-api',
        'data-widget-id',
        'src',
      ]);
      expect(found[0]?.textContent, attack).toBe('');
      expect(html, attack).not.toContain('<svg');
      expect(html.match(/<script/g), attack).toHaveLength(1);
      // The values are all still there, as text.
      expect(found[0]?.getAttribute('data-widget-id'), attack).toBe(id);
    }
  });

  it('writes the values with & < > " and \' escaped', async () => {
    const html = await render({
      widget_id: WIDGET,
      chat_address: 'https://chat.example.com',
      api_address: 'https://api.example.com/a?b=1&c=2',
    });
    expect(html).toContain('data-api="https://api.example.com/a?b=1&amp;c=2"');
  });
});

describe('the Liquid in the block', () => {
  const code = template.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '');

  it('uses only the tags and filters that Shopify and LiquidJS both have', () => {
    const filters = new Set([...code.matchAll(/\|\s*([a-z_]+)/g)].map((match) => match[1]));
    expect([...filters].sort()).toEqual([
      'append',
      'escape',
      'remove_last',
      'slice',
      'split',
      'strip',
    ]);
    const tags = new Set(
      [
        ...code.matchAll(
          /(?:\{%-?|^)\s*(assign|if|unless|else|elsif|endif|endunless|for|endfor|liquid)\b/gm,
        ),
      ].map((match) => match[1]),
    );
    expect([...tags].sort()).toEqual([
      'assign',
      'else',
      'endfor',
      'endif',
      'endunless',
      'for',
      'if',
      'liquid',
      'unless',
    ]);
  });

  it('does not depend on how an engine splits a string with a trailing slash', () => {
    // Ruby drops the empty piece after a last slash and JavaScript keeps it. The block reads only
    // the pieces before it, and strips the trailing slashes of the API address in a loop.
    expect(code).toContain('chat_parts[2]');
    expect(code).not.toMatch(/split[^\n]*\|\s*last|\.last|\.size\s*-\s*1/);
    expect(code).toContain("remove_last: '/'");
  });
});
