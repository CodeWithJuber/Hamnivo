import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  gtmFolder,
  injectPatterns,
  type Permission,
  scenarios,
  section,
  sections,
  templateText,
} from './sandbox.js';

/**
 * Checks of the exported template file, against the format Google Tag Manager imports and the
 * Community Template Gallery reads. Running the template is tested in template-behavior.test.ts.
 */
interface Field {
  type: string;
  name: string;
  displayName: string;
  simpleValueType?: boolean;
  help?: string;
  valueValidators?: { type: string; args?: string[]; errorMessage?: string }[];
}
const fields = JSON.parse(section('TEMPLATE_PARAMETERS')) as Field[];
const code = section('SANDBOXED_JS_FOR_WEB_TEMPLATE');

describe('the sections of the file', () => {
  it('are the ones an exported web tag has, in the order GTM writes them', () => {
    expect(sections(templateText).map(([name]) => name)).toEqual([
      'TERMS_OF_SERVICE',
      'INFO',
      'TEMPLATE_PARAMETERS',
      'SANDBOXED_JS_FOR_WEB_TEMPLATE',
      'WEB_PERMISSIONS',
      'TESTS',
      'NOTES',
    ]);
    expect(section('TERMS_OF_SERVICE')).toContain(
      "Google Tag Manager's Community\nTemplate Gallery Developer Terms of Service",
    );
  });

  it('hold JSON where GTM expects JSON', () => {
    for (const name of ['INFO', 'TEMPLATE_PARAMETERS', 'WEB_PERMISSIONS']) {
      expect(() => JSON.parse(section(name)), name).not.toThrow();
    }
  });
});

describe('the info of the template', () => {
  const info = JSON.parse(section('INFO')) as Record<string, unknown>;

  it('is a web tag called Hamnivo Chat, in the chat category', () => {
    expect(info.type).toBe('TAG');
    expect(info.displayName).toBe('Hamnivo Chat');
    expect(info.categories).toEqual(['CHAT']);
    expect(info.containerContexts).toEqual(['WEB']);
    expect(info.version).toBe(1);
    expect(info.securityGroups).toEqual([]);
    // GTM gives a template its real ID when it is imported or accepted into the gallery.
    expect(info.id).toBe('cvt_temp_public_id');
  });

  it('has a description of a sentence or two, that says where the values come from', () => {
    const description = String(info.description);
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(250);
    expect(description).toContain('Hamnivo Studio');
  });
});

describe('the form', () => {
  it('asks for the widget ID, the chat address and, as the only option, the API address', () => {
    expect(fields.map((field) => [field.name, field.type, field.simpleValueType])).toEqual([
      ['widgetId', 'TEXT', true],
      ['chatUrl', 'TEXT', true],
      ['apiUrl', 'TEXT', true],
    ]);
    const required = (field: Field) => field.valueValidators?.some((v) => v.type === 'NON_EMPTY');
    expect(fields.map((field) => Boolean(required(field)))).toEqual([true, true, false]);
  });

  it('says in its help where each value is in the install code', () => {
    const help = Object.fromEntries(fields.map((field) => [field.name, field.help ?? '']));
    expect(help.widgetId).toContain('data-widget-id');
    expect(help.chatUrl).toContain('/loader.js');
    expect(help.apiUrl).toContain('data-api');
    for (const field of fields)
      expect(field.displayName.length, field.name).toBeLessThanOrEqual(40);
  });

  const regex = (name: string) => {
    const validator = fields
      .find((field) => field.name === name)
      ?.valueValidators?.find((v) => v.type === 'REGEX');
    return new RegExp(validator?.args?.[0] ?? '(?!)');
  };

  it('checks the widget ID as it is typed', () => {
    const widget = regex('widgetId');
    for (const good of ['wid_01j9zk7w3xq8r4t2v6m5n1p0ce', '  wid_01j9zk7w3xq8r4t2v6m5n1p0ce ']) {
      expect(widget.test(good), good).toBe(true);
    }
    for (const bad of [
      '',
      'wid_',
      'wid_01J9ZK7W3XQ8R4T2V6M5N1P0CE',
      'wid_01j9zk7w3xq8r4t2v6m5n1p0c',
      'wid_01j9zk7w3xq8r4t2v6m5n1p0cee',
      'wid_01j9zk7w3xq8r4t2v6m5 1p0ce',
      'brd_01j9zk7w3xq8r4t2v6m5n1p0ce',
    ]) {
      expect(widget.test(bad), bad).toBe(false);
    }
  });

  it('checks the chat address, and that the API address is either empty or an https address', () => {
    const chat = regex('chatUrl');
    for (const good of [
      'https://chat.example.com',
      'https://chat.example.com/',
      'https://chat.example.com:8443/loader.js',
      ' https://chat.example.com ',
    ]) {
      expect(chat.test(good), good).toBe(true);
    }
    for (const bad of [
      '',
      'chat.example.com',
      'http://chat.example.com',
      'https://',
      'https:///loader.js',
      'https://user:pass@chat.example.com',
      'https://chat example.com',
      'javascript:alert(1)',
    ]) {
      expect(chat.test(bad), bad).toBe(false);
    }
    const api = regex('apiUrl');
    for (const good of ['', ' ', 'https://api.example.com', 'https://example.com/api/v1/']) {
      expect(api.test(good), JSON.stringify(good)).toBe(true);
    }
    for (const bad of [
      'api.example.com',
      'http://api.example.com',
      'ftp://api.example.com',
      'https://a.example/?x=1',
    ]) {
      expect(api.test(bad), bad).toBe(false);
    }
  });

  it('gives every regular expression an error message in plain words', () => {
    for (const field of fields) {
      for (const validator of field.valueValidators ?? []) {
        if (validator.type === 'REGEX')
          expect(validator.errorMessage?.length, field.name).toBeGreaterThan(20);
      }
    }
  });
});

describe('the code', () => {
  const stripped = code
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  it('reads only the settings the form has, and the two callbacks GTM gives a tag', () => {
    const used = new Set([...code.matchAll(/\bdata\.(\w+)/g)].map((match) => match[1]));
    const allowed = new Set([...fields.map((field) => field.name), 'gtmOnSuccess', 'gtmOnFailure']);
    for (const name of used) expect(allowed.has(name as string), `data.${name}`).toBe(true);
    for (const field of fields) expect(used.has(field.name), field.name).toBe(true);
  });

  it('keeps to what the GTM sandbox runs: no regular expression, template literal, class, new or async', () => {
    // The sandbox has no regular expressions. After comments and strings are removed, no slash is
    // left: there is no division in the code either.
    expect(stripped).not.toContain('/');
    expect(stripped).not.toMatch(
      /`|\bclass\b|\bnew\b|\basync\b|\bawait\b|\bRegExp\b|\.match\(|\.test\(/,
    );
    expect(stripped).not.toMatch(/\b(window|document|navigator|eval|Function|setTimeout|fetch)\b/);
  });

  it('requires only the APIs it needs, and every one of them is a documented sandbox API', () => {
    const required = [...code.matchAll(/require\('(\w+)'\)/g)].map((match) => match[1]);
    expect(required.sort()).toEqual(
      [
        'encodeUriComponent',
        'injectScript',
        'logToConsole',
        'makeString',
        'parseUrl',
        'queryPermission',
      ].sort(),
    );
  });

  it('asks for permission before it loads anything, and fails the tag when it is refused', () => {
    expect(code.indexOf("queryPermission('inject_script', url)")).toBeGreaterThan(-1);
    expect(code.indexOf("queryPermission('inject_script', url)")).toBeLessThan(
      code.indexOf('injectScript(url'),
    );
    expect(code).toContain('injectScript(url, data.gtmOnSuccess, data.gtmOnFailure, url)');
  });
});

describe('the permissions', () => {
  const permissions = JSON.parse(section('WEB_PERMISSIONS')) as Permission[];

  it('are logging in debug mode and the injection of loader.js, and nothing else', () => {
    expect(permissions.map((p) => p.instance.key.publicId).sort()).toEqual([
      'inject_script',
      'logging',
    ]);
    const logging = permissions.find((p) => p.instance.key.publicId === 'logging');
    expect(logging?.instance.param).toEqual([
      { key: 'environments', value: { type: 1, string: 'debug' } },
    ]);
  });

  it('let the tag load loader.js over https from the chat address, which only the customer knows', () => {
    expect(injectPatterns()).toEqual(['https://*/loader.js*']);
    for (const pattern of injectPatterns()) {
      expect(pattern.startsWith('https://')).toBe(true);
      expect(pattern).toContain('/loader.js');
    }
  });
});

describe('the tests in the file', () => {
  const found = scenarios(section('TESTS'));

  it('are scenarios with a name and code, which the template editor runs', () => {
    expect(section('TESTS').startsWith('scenarios:\n- name: ')).toBe(true);
    expect(found.length).toBeGreaterThanOrEqual(10);
    expect(new Set(found.map((scenario) => scenario.name)).size).toBe(found.length);
    for (const scenario of found) {
      expect(scenario.code, scenario.name).toContain('runCode(');
      expect(scenario.code, scenario.name).toMatch(/assertApi\(|assertThat\(/);
    }
  });

  it('cover a good setup, a missing API address, trimming, and each refusal', () => {
    const names = found.map((scenario) => scenario.name).join('\n');
    for (const topic of [
      'Loads the loader',
      'Leaves out the API address',
      'only the origin',
      'Trims',
      'widget ID',
      'not https',
      'API address that is not',
      'login',
      'may not load',
      'cannot be loaded',
    ]) {
      expect(names, topic).toContain(topic);
    }
  });
});

describe('the folder', () => {
  it('has what the Community Template Gallery asks for, with the Apache 2.0 licence it requires', () => {
    expect(existsSync(join(gtmFolder, 'metadata.yaml'))).toBe(true);
    const license = readFileSync(join(gtmFolder, 'LICENSE'), 'utf8');
    expect(license).toContain(
      'Apache License\n                           Version 2.0, January 2004',
    );
    expect(license).toContain('Copyright 2026 Juber Shaikh');
    expect(license).not.toContain('[yyyy]');
    const metadata = readFileSync(join(gtmFolder, 'metadata.yaml'), 'utf8');
    expect(metadata).toMatch(/^homepage: "https:\/\/github\.com\/CodeWithJuber\/Hamnivo"$/m);
    expect(metadata).toMatch(
      /^documentation: "https:\/\/github\.com\/CodeWithJuber\/Hamnivo\/blob\/main\/docs\/guide\/integrations\/gtm\.md"$/m,
    );
    expect(metadata).toMatch(/^versions:$/m);
    expect(metadata).toMatch(/changeNotes: /);
  });
});
