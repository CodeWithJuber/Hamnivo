import { describe, expect, it } from 'vitest';
import { runScenario, runTemplate, scenarios, section } from './sandbox.js';

/**
 * The template run with the stand-in for GTM's sandbox: the tests written in the file itself, and
 * a wider set of settings, good and bad.
 */
const code = section('SANDBOXED_JS_FOR_WEB_TEMPLATE');
const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
const run = (data: Record<string, unknown>) => runTemplate(code, data);

describe('the tests written in the file', () => {
  for (const scenario of scenarios(section('TESTS'))) {
    it(scenario.name, () => {
      runScenario(code, scenario.code);
    });
  }
});

describe('the address it loads', () => {
  it('is loader.js on the origin of the chat address, with the widget ID and the API address in its query', () => {
    const result = run({
      widgetId: WIDGET,
      chatUrl: 'https://chat.example.com',
      apiUrl: 'https://api.example.com',
    });
    expect(result.injected).toEqual([
      `https://chat.example.com/loader.js?widgetId=${WIDGET}&api=https%3A%2F%2Fapi.example.com`,
    ]);
    expect(result.success).toBe(1);
    expect(result.failure).toBe(0);
    expect(result.logs).toEqual([]);
  });

  it('puts exactly those two things in the query, and reads back as they were typed', () => {
    const result = run({
      widgetId: WIDGET,
      chatUrl: 'https://chat.example.com/some/page',
      apiUrl: 'https://example.com/api/v1//',
    });
    const url = new URL(result.injected[0] as string);
    expect(url.origin).toBe('https://chat.example.com');
    expect(url.pathname).toBe('/loader.js');
    expect([...url.searchParams.keys()]).toEqual(['widgetId', 'api']);
    expect(url.searchParams.get('widgetId')).toBe(WIDGET);
    expect(url.searchParams.get('api')).toBe('https://example.com/api/v1');
  });

  it('uses the address as the cache token, so a single-page site loads it once', () => {
    const result = run({ widgetId: WIDGET, chatUrl: 'https://chat.example.com' });
    const call = result.calls.find((entry) => entry.api === 'injectScript');
    expect(call?.args[3]).toBe(call?.args[0]);
    expect(call?.args[1]).toBeTypeOf('function');
    expect(call?.args[2]).toBeTypeOf('function');
  });

  it('is allowed by the permission, for any https host and port, but not for another file', () => {
    for (const host of [
      'chat.example.com',
      'chat.example.co.uk',
      'localhost:3000',
      '203.0.113.7:8443',
    ]) {
      const result = run({ widgetId: WIDGET, chatUrl: `https://${host}` });
      expect(result.success, host).toBe(1);
      expect(result.injected, host).toEqual([`https://${host}/loader.js?widgetId=${WIDGET}`]);
    }
    // The stand-in's permission check is the template editor's pattern, so another file is refused.
    const other = runTemplate(
      `const q = require('queryPermission'); data.out = q('inject_script', 'https://chat.example.com/other.js');`,
      {},
    );
    expect(other.calls.at(0)?.args).toEqual(['inject_script', 'https://chat.example.com/other.js']);
  });
});

describe('what it refuses', () => {
  const good = { widgetId: WIDGET, chatUrl: 'https://chat.example.com' };

  function expectRefused(settings: Record<string, unknown>, label: string) {
    const result = run(settings);
    expect(result.injected, label).toEqual([]);
    expect(result.failure, label).toBe(1);
    expect(result.success, label).toBe(0);
    expect(result.logs.length, label).toBe(1);
    expect(result.logs[0], label).toMatch(/^Hamnivo Chat: /);
  }

  it('takes only a widget ID of wid_ and 26 lower-case letters and digits', () => {
    for (const widgetId of [
      undefined,
      '',
      '   ',
      'wid_',
      'wid_01J9ZK7W3XQ8R4T2V6M5N1P0CE',
      'wid_01j9zk7w3xq8r4t2v6m5n1p0c',
      'wid_01j9zk7w3xq8r4t2v6m5n1p0cee',
      'wid_01j9zk7w3xq8r4t2v6m5 1p0ce',
      'wid_01j9zk7w3xq8r4t2v6m5n1p0c-',
      'brd_01j9zk7w3xq8r4t2v6m5n1p0ce',
      'wid_01j9zk7w3xq8r4t2v6m5n1p0ce"><script>alert(1)</script>',
      12345,
      { id: WIDGET },
    ]) {
      expectRefused({ ...good, widgetId }, `widget ID ${JSON.stringify(widgetId)}`);
    }
  });

  it('takes only an https chat address with a host name and no login', () => {
    for (const chatUrl of [
      undefined,
      '',
      'chat.example.com',
      '//chat.example.com',
      'http://chat.example.com',
      'ftp://chat.example.com',
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://',
      'https:///loader.js',
      'https://user:pass@chat.example.com',
      'https://user@chat.example.com',
      'https://chat example.com',
      'https://chat.example.com/?x=1',
      'https://chat.example.com/#top',
      42,
    ]) {
      expectRefused({ ...good, chatUrl }, `chat address ${JSON.stringify(chatUrl)}`);
    }
  });

  it('takes an API address only when it is empty or an https address like that', () => {
    for (const apiUrl of [
      'api.example.com',
      'http://api.example.com',
      'ftp://api.example.com',
      'javascript:alert(1)',
      'https://user:pass@api.example.com',
      'https://api.example.com/?x=1',
      'https://api example.com',
    ]) {
      expectRefused({ ...good, apiUrl }, `API address ${JSON.stringify(apiUrl)}`);
    }
    for (const apiUrl of [undefined, '', '   ']) {
      const result = run({ ...good, apiUrl });
      expect(result.success, JSON.stringify(apiUrl)).toBe(1);
      expect(result.injected[0], JSON.stringify(apiUrl)).not.toContain('api=');
    }
  });

  it('says which of the three is wrong, in words for the person who set the tag up', () => {
    expect(run({ ...good, widgetId: 'nope' }).logs[0]).toContain('widget ID is wid_');
    expect(run({ ...good, chatUrl: 'nope' }).logs[0]).toContain(
      'chat address must start with https://',
    );
    expect(run({ ...good, apiUrl: 'nope' }).logs[0]).toContain(
      'API address must start with https://',
    );
  });

  it('fails the tag, once, when the template is not allowed to load the address', () => {
    const result = runTemplate(code, good, { mocks: { queryPermission: false } });
    expect(result.injected).toEqual([]);
    expect(result.failure).toBe(1);
    expect(result.logs[0]).toContain('may not load https://chat.example.com/loader.js?widgetId=');
    expect(result.logs[0]).toContain('Permissions');
  });

  it('fails the tag, once, when the script does not load, and reports success only when it does', () => {
    const failed = runTemplate(code, good, {
      mocks: {
        injectScript: (_url: unknown, _ok: unknown, onFailure: unknown) =>
          (onFailure as () => void)(),
      },
    });
    expect([failed.success, failed.failure]).toEqual([0, 1]);
    const loaded = run(good);
    expect([loaded.success, loaded.failure]).toEqual([1, 0]);
  });

  it('does not call a callback itself: loading the script decides', () => {
    const hung = runTemplate(code, good, { mocks: { injectScript: () => undefined } });
    expect([hung.success, hung.failure]).toEqual([0, 0]);
    expect(hung.injected).toHaveLength(1);
  });
});
