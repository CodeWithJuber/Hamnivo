import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Checks of the files that make the Shopify app, against the rules in Shopify's documentation for
 * theme app extensions: the folders the CLI reads, the schema of the app embed block, and the size
 * limits it enforces when the app is deployed. The block rendered with settings is tested in
 * app-embed.test.ts.
 */
const app = join(import.meta.dirname, '../../../integrations/shopify');
const extension = join(app, 'extensions/hamnivo-chat');
const read = (path: string) => readFileSync(join(extension, path), 'utf8');

const block = read('blocks/hamnivo-chat.liquid');
const schemaText = /\{% schema %\}([\s\S]*?)\{% endschema %\}/.exec(block)?.[1] ?? '';
const schema = JSON.parse(schemaText) as {
  name: string;
  target: string;
  settings: { type: string; id: string; label: string; info?: string }[];
};
const locale = JSON.parse(read('locales/en.default.schema.json')) as Record<string, unknown>;

/** The value of a key written as a path of names, such as blocks.hamnivo_chat.name. */
function lookup(path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((value, name) => (value as Record<string, unknown>)?.[name], locale);
}

function leaves(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([name, inner]) =>
    leaves(inner, prefix ? `${prefix}.${name}` : name),
  );
}

describe('the folders of the extension', () => {
  it('are the ones the Shopify CLI reads, and the extension is a theme extension', () => {
    const folders = readdirSync(extension).sort();
    expect(folders).toEqual(['blocks', 'locales', 'shopify.extension.toml']);
    for (const name of folders) {
      if (name.endsWith('.toml')) continue;
      expect(['assets', 'blocks', 'locales', 'snippets']).toContain(name);
    }
    const toml = read('shopify.extension.toml');
    expect(toml).toMatch(/^name = "Hamnivo Chat"$/m);
    expect(toml).toMatch(/^type = "theme"$/m);
  });

  it('name the extension and the block the same, because the deep link that turns the embed on uses it', () => {
    expect(read('shopify.extension.toml')).toMatch(/^handle = "hamnivo-chat"$/m);
    expect(readdirSync(join(extension, 'blocks'))).toEqual(['hamnivo-chat.liquid']);
  });

  it('stay inside the limits Shopify enforces when the app is deployed', () => {
    const size = (directory: string): number =>
      readdirSync(directory).reduce((sum, name) => {
        const path = join(directory, name);
        return sum + (statSync(path).isDirectory() ? size(path) : statSync(path).size);
      }, 0);
    expect(size(extension)).toBeLessThan(10 * 1024 * 1024);
    expect(readdirSync(join(extension, 'blocks')).length).toBeLessThanOrEqual(30);
    expect(Buffer.byteLength(block)).toBeLessThan(100 * 1024);
    for (const name of readdirSync(join(extension, 'locales'))) {
      expect(statSync(join(extension, 'locales', name)).size, name).toBeLessThan(15 * 1024);
    }
    expect(readdirSync(join(extension, 'locales')).length).toBeLessThanOrEqual(100);
  });
});

describe('the schema of the app embed block', () => {
  it('is an app embed for the end of the body, with a name that fits the theme editor', () => {
    expect(schema.target).toBe('body');
    expect(schema.name).toBe('Hamnivo Chat');
    expect(schema.name.length).toBeLessThanOrEqual(25);
  });

  it('asks for the widget ID, the chat address and the API address, in text fields, and the block reads exactly those', () => {
    expect(schema.settings.map((setting) => [setting.id, setting.type])).toEqual([
      ['widget_id', 'text'],
      ['chat_address', 'text'],
      ['api_address', 'text'],
    ]);
    const used = new Set([...block.matchAll(/block\.settings\.(\w+)/g)].map((match) => match[1]));
    expect([...used].sort()).toEqual(schema.settings.map((setting) => setting.id).sort());
  });

  it('keeps every label and help text in the locale file, and the locale file holds nothing else', () => {
    const keys = schema.settings.flatMap((setting) => [setting.label, setting.info ?? '']);
    for (const key of keys) {
      expect(key, key).toMatch(/^t:blocks\.hamnivo_chat\.settings\.\w+\.(label|info)$/);
      const text = lookup(key.slice(2));
      expect(typeof text, key).toBe('string');
      expect((text as string).length, key).toBeGreaterThan(0);
    }
    expect(leaves(locale).sort()).toEqual(keys.map((key) => key.slice(2)).sort());
  });

  it('says where each value comes from in the install code, in words a store owner knows', () => {
    const text = JSON.stringify(locale);
    expect(text).toContain('data-widget-id');
    expect(text).toContain('/loader.js');
    expect(text).toContain('data-api');
    expect(text).toContain('Hamnivo Studio');
  });
});

describe('the Liquid of the block', () => {
  it('uses none of the tags that Shopify forbids in app blocks', () => {
    for (const tag of [
      'javascript',
      'stylesheet',
      'layout',
      'section',
      'sections',
      'render',
      'include',
    ]) {
      expect(block, tag).not.toMatch(new RegExp(`\\{%-?\\s*${tag}\\b`));
    }
  });

  it('holds no address of its own: the loader comes from the setting', () => {
    const code = block
      .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '')
      .replace(/\{% schema %\}[\s\S]*$/, '');
    expect(code).not.toMatch(/https?:\/\/[a-z]/i);
  });

  it('loads the script async, so that it never slows the page down', () => {
    expect(block).toMatch(/<script\s+async\b/);
    expect(block).not.toMatch(/\bdocument\.write\b/);
  });
});

describe('the app', () => {
  const toml = readFileSync(join(app, 'shopify.app.toml'), 'utf8');

  it('is an extension-only app that asks for no access to the store, and holds no client ID', () => {
    expect(toml).toMatch(/^name = "Hamnivo Chat"$/m);
    expect(toml).toMatch(/^client_id = ""$/m);
    expect(toml).toMatch(/^scopes = ""$/m);
    expect(toml).toMatch(/^application_url = "https:\/\/shopify\.dev\/apps\/default-app-home"$/m);
    expect(toml).toMatch(/^api_version = "20\d\d-(01|04|07|10)"$/m);
    expect(toml).not.toMatch(/\[\[webhooks\.subscriptions\]\]/);
  });

  it('keeps the CLI cache and local settings out of git', () => {
    const ignore = readFileSync(join(app, '.gitignore'), 'utf8');
    expect(ignore).toContain('.shopify/');
    expect(ignore).toContain('.env');
  });

  it('has a README for the developer who deploys it, and no copy of the loader or of secrets', () => {
    expect(existsSync(join(app, 'README.md'))).toBe(true);
    expect(existsSync(join(extension, 'assets'))).toBe(false);
  });
});
