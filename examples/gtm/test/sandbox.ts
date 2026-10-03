import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * A small stand-in for Google Tag Manager's sandbox, enough to run the template here: the
 * sections of the exported file, the APIs the template requires, and the test commands that the
 * template editor offers (mock, runCode, assertApi, assertThat). GTM itself is the final check:
 * import the file there and run its tests.
 */
export const gtmFolder = join(import.meta.dirname, '../../../integrations/gtm');
export const templateText = readFileSync(join(gtmFolder, 'template.tpl'), 'utf8');

/** The sections of an exported template file, in order. */
export function sections(text: string): [string, string][] {
  const marks = [...text.matchAll(/^___([A-Z_]+)___$/gm)];
  return marks.map((mark, index) => {
    const start = (mark.index ?? 0) + mark[0].length;
    const end = marks[index + 1]?.index ?? text.length;
    return [mark[1] as string, text.slice(start, end).trim()];
  });
}

export const section = (name: string): string =>
  sections(templateText).find(([found]) => found === name)?.[1] ?? '';

export interface Permission {
  instance: {
    key: { publicId: string; versionId: string };
    param: {
      key: string;
      value: { type: number; string?: string; listItem?: { string: string }[] };
    }[];
  };
  isRequired?: boolean;
}

/** The URL patterns of the inject_script permission, as the template editor lists them. */
export function injectPatterns(): string[] {
  const permissions = JSON.parse(section('WEB_PERMISSIONS')) as Permission[];
  const inject = permissions.find((p) => p.instance.key.publicId === 'inject_script');
  const urls = inject?.instance.param.find((p) => p.key === 'urls');
  return (urls?.value.listItem ?? []).map((item) => item.string);
}

/** A match pattern of the template editor as a regular expression: * matches anything. */
function patternToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}$`);
}

type Api = (...args: unknown[]) => unknown;

export interface Run {
  /** Every call the template made to an API, in order. */
  calls: { api: string; args: unknown[] }[];
  logs: string[];
  /** The addresses given to injectScript. */
  injected: string[];
  success: number;
  failure: number;
}

export interface RunOptions {
  /** Replacements for the template's APIs, as mock() does in the template editor. */
  mocks?: Record<string, Api | unknown>;
  patterns?: string[];
}

function parseUrl(text: unknown) {
  try {
    const url = new URL(String(text));
    return {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      username: url.username,
      password: url.password,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    };
  } catch {
    return undefined;
  }
}

/** Runs the sandboxed code once, as the body of a function, with the given tag settings. */
export function runTemplate(
  code: string,
  data: Record<string, unknown>,
  options: RunOptions = {},
): Run {
  const run: Run = { calls: [], logs: [], injected: [], success: 0, failure: 0 };
  const patterns = (options.patterns ?? injectPatterns()).map(patternToRegExp);
  const defaults: Record<string, Api> = {
    // The real one loads the script, then calls the first function.
    injectScript: (_url, onSuccess) => {
      (onSuccess as () => void)();
    },
    queryPermission: (permission, url) =>
      permission === 'inject_script' && patterns.some((pattern) => pattern.test(String(url))),
    parseUrl,
    encodeUriComponent: (value) => encodeURIComponent(String(value)),
    logToConsole: (...args) => {
      run.logs.push(args.map(String).join(' '));
    },
    makeString: (value) => String(value),
  };
  const load = (name: string): Api => {
    if (!(name in defaults))
      throw new Error(`The template needs ${name}, which this stand-in lacks`);
    return (...args) => {
      run.calls.push({ api: name, args });
      if (name === 'injectScript') run.injected.push(String(args[0]));
      const replacement = options.mocks?.[name];
      if (typeof replacement === 'function') return (replacement as Api)(...args);
      if (replacement !== undefined) return replacement;
      return (defaults[name] as Api)(...args);
    };
  };
  const tagData = {
    ...data,
    gtmOnSuccess: () => {
      run.success += 1;
    },
    gtmOnFailure: () => {
      run.failure += 1;
    },
  };
  const body = new vm.Script(`(function (data, require) {\n${code}\n})`, {
    filename: 'template.js',
  });
  const fn = body.runInNewContext({}) as (data: unknown, require: (name: string) => Api) => unknown;
  fn(tagData, load);
  return run;
}

/** The scenarios of the ___TESTS___ section: a name, and the code that the editor runs. */
export function scenarios(text: string): { name: string; code: string }[] {
  const found: { name: string; code: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const name = /^- name: (.*)$/.exec(lines[i] as string)?.[1];
    if (name === undefined) continue;
    if (lines[i + 1] !== '  code: |-') throw new Error(`Scenario "${name}" has no code block`);
    const code: string[] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const line = lines[j] as string;
      if (line.startsWith('    ')) code.push(line.slice(4));
      else if (line === '') code.push('');
      else break;
    }
    while (code.at(-1) === '') code.pop();
    found.push({ name, code: code.join('\n') });
    i = j - 1;
  }
  return found;
}

/** Runs one scenario with the template editor's test commands. Throws when it fails. */
export function runScenario(templateCode: string, scenario: string): void {
  const mocks: Record<string, Api | unknown> = {};
  let last: Run | undefined;
  const counts = (name: string): number => {
    if (!last) throw new Error('assertApi before runCode');
    if (name === 'gtmOnSuccess') return last.success;
    if (name === 'gtmOnFailure') return last.failure;
    return last.calls.filter((call) => call.api === name).length;
  };
  const commands = {
    mock: (name: string, replacement: Api | unknown) => {
      mocks[name] = replacement;
    },
    runCode: (data: Record<string, unknown>) => {
      last = runTemplate(templateCode, data, { mocks });
    },
    assertApi: (name: string) => ({
      wasCalled: () => {
        if (counts(name) === 0) throw new Error(`${name} was not called`);
      },
      wasNotCalled: () => {
        if (counts(name) !== 0) throw new Error(`${name} was called ${counts(name)} times`);
      },
    }),
    assertThat: (actual: unknown) => ({
      isEqualTo: (expected: unknown) => {
        if (actual !== expected) {
          throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      },
    }),
  };
  new vm.Script(scenario, { filename: 'scenario.js' }).runInNewContext(commands);
}
