import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Checks of the addon's files that need neither PHP nor WHMCS: the functions WHMCS calls, the
 * settings it draws, and the rules that keep the addon safe inside a billing system. The addon
 * running (with stand-ins for what WHMCS gives it) is tested by the next file.
 */
const addon = join(import.meta.dirname, '../../../integrations/whmcs/modules/addons/hamnivo');
const read = (path: string) => readFileSync(join(addon, path), 'utf8');

function files(directory: string, extension: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : files(path, extension);
    return path.endsWith(extension) ? [path] : [];
  });
}
const phpFiles = files(addon, '.php');
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the files WHMCS loads', () => {
  it('are hamnivo.php and hooks.php, and neither runs on its own', () => {
    for (const name of ['hamnivo.php', 'hooks.php']) {
      expect(read(name), name).toMatch(/if \(!defined\('WHMCS'\)\) \{\s+die\(/);
    }
  });

  it('define every function WHMCS calls for an addon module', () => {
    const main = read('hamnivo.php');
    for (const name of ['config', 'activate', 'deactivate', 'upgrade', 'output', 'clientarea']) {
      expect(main, name).toMatch(new RegExp(`^function hamnivo_${name}\\(`, 'm'));
    }
  });

  it('add the chat to the client area through the ClientAreaHeadOutput hook, and never break the page', () => {
    const hooks = read('hooks.php');
    expect(hooks).toMatch(/add_hook\('ClientAreaHeadOutput', \d+, function \(\$vars\)/);
    expect(hooks).toContain('catch (\\Throwable $error)');
    expect(hooks).toMatch(/catch \(\\Throwable \$error\) \{\s+return '';/);
  });
});

describe('the settings form', () => {
  const main = read('hamnivo.php');
  const config = main.slice(
    main.indexOf('function hamnivo_config'),
    main.indexOf('function hamnivo_activate'),
  );
  const fields = [...config.matchAll(/^ {12}'(\w+)' => \[$/gm)].map((match) => match[1]);

  it('draws one field for each setting the addon reads, and no other', () => {
    const settings = read('lib/Settings.php');
    const read_ = [
      ...(/private const FIELDS = \[([^\]]+)\]/.exec(settings)?.[1] ?? '').matchAll(/'(\w+)'/g),
    ].map((match) => match[1]);
    expect(fields).toEqual(read_);
    expect(fields).toEqual([
      'widget_id',
      'chat_url',
      'api_url',
      'identity_enabled',
      'identity_kid',
      'identity_secret',
      'trust_emails',
      'share_products',
    ]);
  });

  it('keeps the key in a password field, the choices in tick boxes and the rest in text fields', () => {
    const types: Record<string, string> = {
      widget_id: 'text',
      chat_url: 'text',
      api_url: 'text',
      identity_enabled: 'yesno',
      identity_kid: 'text',
      identity_secret: 'password',
      trust_emails: 'yesno',
      share_products: 'yesno',
    };
    for (const field of fields) {
      const block = config.slice(config.indexOf(`'${field}' => [`));
      expect(/'Type' => '(\w+)'/.exec(block)?.[1], field).toBe(types[field as string]);
      expect(block, field).toMatch(/'FriendlyName' => '[^']+'/);
    }
  });

  it('offers to keep the key in configuration.php, outside the database', () => {
    expect(config).toContain('HAMNIVO_IDENTITY_SECRET');
    expect(read('lib/Settings.php')).toContain("defined('HAMNIVO_IDENTITY_SECRET')");
  });

  it('turns the off-by-default options off, so that nothing is shared until the admin ticks it', () => {
    for (const field of ['identity_enabled', 'trust_emails', 'share_products']) {
      const block = config.slice(config.indexOf(`'${field}' => [`));
      const own = block.slice(0, block.indexOf('],'));
      expect(own, field).not.toMatch(/'Default' => '(on|1|yes)'/i);
    }
  });

  it('gives the version once, from the class that puts it on the script address', () => {
    expect(read('lib/Output.php')).toMatch(/public const VERSION = '\d+\.\d+\.\d+';/);
    expect(config).toContain("'version' => Output::VERSION");
  });
});

describe('the PHP files', () => {
  it('hold only declarations in lib/, so a request for one of them does nothing', () => {
    for (const path of phpFiles.filter((file) => file.includes('/lib/'))) {
      const name = relative(addon, path);
      if (name === 'lib/bootstrap.php') continue;
      expect(code(path), name).toMatch(
        /^<\?php\s+declare\(strict_types=1\);\s+namespace Hamnivo\\Whmcs;\s+(use [\w\\]+;\s+)*(final class|interface) \w+/,
      );
    }
  });

  it('do not end with a closing tag, which would print a newline into the page', () => {
    for (const path of phpFiles) {
      expect(readFileSync(path, 'utf8').trimEnd().endsWith('?>'), relative(addon, path)).toBe(
        false,
      );
    }
  });

  it('use no debugging, no dynamic code and no shell', () => {
    for (const path of phpFiles) {
      expect(code(path), relative(addon, path)).not.toMatch(
        /\b(error_log|var_dump|print_r|var_export|eval|assert|create_function|extract|serialize|unserialize|shell_exec|exec|system|passthru|popen|proc_open|file_put_contents|fwrite|unlink|mail)\s*\(/,
      );
    }
  });

  it('read the request in two places only: the addon page and the identity address', () => {
    const uses = phpFiles.flatMap((path) =>
      code(path)
        .split('\n')
        .filter((line) => /\$_(GET|POST|REQUEST|COOKIE|FILES|SERVER|SESSION)\b/.test(line))
        .map((line) => `${relative(addon, path)}: ${line.trim()}`),
    );
    expect(uses.filter((use) => !/^(hamnivo\.php|lib\/CurrentClient\.php):/.test(use))).toEqual([]);
    expect(uses.join('\n')).not.toMatch(/\$_(REQUEST|COOKIE|FILES)\b/);
    // The one query value is the action, and the one posted value is the Test connection button.
    const main = code(join(addon, 'hamnivo.php'));
    const names = (superglobal: string) => [
      ...new Set(
        [...main.matchAll(new RegExp(`\\$_${superglobal}\\['(\\w+)'\\]`, 'g'))].map((m) => m[1]),
      ),
    ];
    expect(names('GET')).toEqual(['a']);
    expect(names('POST')).toEqual(['hamnivo_test']);
  });

  it('never read the key outside the code that signs with it and the code that checks it', () => {
    // hamnivo.php only names the field, to draw the form.
    const mayName = [
      'hamnivo.php',
      'lib/Identity.php',
      'lib/ConnectionTest.php',
      'lib/Settings.php',
    ];
    for (const path of phpFiles) {
      const name = relative(addon, path);
      if (mayName.includes(name)) continue;
      expect(code(path), name).not.toMatch(/->secret\(\)|identity_secret/);
    }
    expect(code(join(addon, 'hamnivo.php'))).not.toContain('->secret()');
  });

  it('answer the identity request with a response that no cache may keep', () => {
    const endpoint = read('lib/Endpoint.php');
    expect(endpoint).toContain("'Cache-Control' => 'no-store, private'");
    expect(endpoint).toContain("'X-Content-Type-Options' => 'nosniff'");
    expect(endpoint).toContain("'x-requested-with'");
    expect(endpoint).toContain("'sec-fetch-site'");
  });

  it('use PHP 7.4 syntax only, so the chat loads on older hosts', () => {
    for (const path of phpFiles) {
      const text = code(path);
      const name = relative(addon, path);
      expect(text, name).not.toMatch(/\bmatch\s*\(/);
      expect(text, name).not.toMatch(/\?->/);
      expect(text, name).not.toMatch(/\breadonly\b/);
      expect(text, name).not.toMatch(/\benum\s+\w+/);
      expect(text, name).not.toMatch(/function\s+\w+\s*\([^)]*\b(mixed|never)\b/);
      expect(text, name).not.toMatch(/\)\s*:\s*(mixed|never|static|\w+\|\w+)/);
      expect(text, name).not.toMatch(/\bnew\s+\w+\([^)]*\b\w+:\s/);
      expect(text, name).not.toMatch(/#\[/);
    }
  });

  const php = spawnSync('php', ['-v'], { stdio: 'ignore' });
  it.skipIf(php.status !== 0)('have no syntax error (checked with the PHP on this machine)', () => {
    for (const path of phpFiles) {
      const result = spawnSync('php', ['-l', path], { encoding: 'utf8' });
      expect(result.stderr + result.stdout, relative(addon, path)).toMatch(/No syntax errors/);
    }
  });
});

describe('the browser script', () => {
  it('writes no HTML and runs no dynamic code', () => {
    expect(read('assets/identity.js')).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/,
    );
  });

  it('only talks to the address WHMCS gave the page, and sends no cookie to another website', () => {
    const script = read('assets/identity.js');
    expect(script).toContain("credentials: 'same-origin'");
    expect(script).toContain('config.endpoint');
    expect(script).not.toMatch(/https?:\/\//);
  });
});

describe('what ships with the addon', () => {
  it('has a licence and a README next to the code', () => {
    expect(existsSync(join(addon, 'LICENSE'))).toBe(true);
    expect(read('README.md')).toContain('Hamnivo Chat for WHMCS');
  });

  it('keeps its tests out of the folder a customer uploads', () => {
    const build = readFileSync(
      join(import.meta.dirname, '../../../scripts/build-integrations.sh'),
      'utf8',
    );
    expect(build).toContain('rm -rf "$dest/tests"');
  });
});
