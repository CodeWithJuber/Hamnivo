import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Checks of the plugin's files that need neither PHP nor WordPress: the headers WordPress and
 * WordPress.org read, the rules a plugin must keep to be accepted, and that the translation
 * template is current. The plugin running inside WordPress is tested in
 * integrations/wordpress/tests (WordPress Playground).
 */
const root = join(import.meta.dirname, '../../../integrations/wordpress');
const plugin = join(root, 'hamnivo-chat');
const read = (path: string) => readFileSync(join(plugin, path), 'utf8');

function files(directory: string, extension: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'lib' ? [] : files(path, extension);
    return path.endsWith(extension) ? [path] : [];
  });
}
const phpFiles = files(plugin, '.php');
const header = (name: string) =>
  new RegExp(`^ \\* ${name}:\\s*(.+)$`, 'm').exec(read('hamnivo-chat.php'))?.[1];

describe('the plugin headers', () => {
  it('name the plugin, its folder as the text domain, and the PHP and WordPress it needs', () => {
    expect(header('Plugin Name')).toBe('Hamnivo Chat');
    expect(header('Text Domain')).toBe('hamnivo-chat');
    expect(header('Domain Path')).toBe('/languages');
    expect(header('Requires at least')).toBe('6.0');
    expect(header('Requires PHP')).toBe('7.4');
    expect(header('License')).toBe('MIT');
    expect(existsSync(join(plugin, 'languages'))).toBe(true);
  });

  it('give one version in the header, the constant and readme.txt', () => {
    const constant = /define\( 'HAMNIVO_CHAT_VERSION', '([^']+)' \)/.exec(
      read('hamnivo-chat.php'),
    )?.[1];
    const stable = /^Stable tag:\s*(\S+)/m.exec(read('readme.txt'))?.[1];
    expect(header('Version')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(constant).toBe(header('Version'));
    expect(stable).toBe(header('Version'));
    expect(read('readme.txt')).toContain(`= ${header('Version')} =`);
  });
});

describe('readme.txt', () => {
  const readme = read('readme.txt');

  it('has the fields and sections WordPress.org reads', () => {
    expect(readme.startsWith('=== Hamnivo Chat ===\n')).toBe(true);
    for (const field of [
      'Contributors',
      'Tags',
      'Requires at least',
      'Tested up to',
      'Requires PHP',
      'Stable tag',
      'License',
      'License URI',
    ]) {
      expect(readme, field).toMatch(new RegExp(`^${field}: .+`, 'm'));
    }
    for (const section of [
      'Description',
      'Installation',
      'Frequently Asked Questions',
      'External services',
      'Changelog',
      'Upgrade Notice',
    ]) {
      expect(readme, section).toContain(`== ${section} ==`);
    }
  });

  it('keeps to the limits: five tags, a short description of at most 150 characters', () => {
    const tags = /^Tags: (.+)$/m.exec(readme)?.[1]?.split(',') ?? [];
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.length).toBeLessThanOrEqual(5);
    const short = readme.split('\n\n')[1]?.trim() ?? '';
    expect(short.length).toBeGreaterThan(20);
    expect(short.length).toBeLessThanOrEqual(150);
  });

  it('agrees with the plugin on the versions it needs', () => {
    expect(/^Requires at least: (.+)$/m.exec(readme)?.[1]).toBe(header('Requires at least'));
    expect(/^Requires PHP: (.+)$/m.exec(readme)?.[1]).toBe(header('Requires PHP'));
  });
});

describe('the PHP files', () => {
  it('never run on their own, and do not end with a closing tag', () => {
    for (const path of phpFiles) {
      const text = readFileSync(path, 'utf8');
      const name = relative(plugin, path);
      expect(text, name).toMatch(/defined\( 'ABSPATH' \) \|\| exit;|WP_UNINSTALL_PLUGIN/);
      expect(text.trimEnd().endsWith('?>'), name).toBe(false);
    }
  });

  it('use no debugging, no dynamic code and no output of raw superglobals', () => {
    for (const path of phpFiles) {
      const text = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const name = relative(plugin, path);
      expect(text, name).not.toMatch(
        /\b(error_log|var_dump|print_r|var_export|eval|assert|create_function|extract|base64_decode|serialize|unserialize|shell_exec|exec|system|passthru|popen|proc_open)\s*\(/,
      );
      expect(text, name).not.toMatch(/\$_(REQUEST|GET|COOKIE|FILES)\b/);
    }
  });

  it('read $_POST in one place, after the nonce and the capability are checked', () => {
    const uses = phpFiles.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => /\$_(POST|SERVER)\b/.test(line))
        .map((line) => `${relative(plugin, path)}: ${line.trim()}`),
    );
    expect(uses).toHaveLength(1);
    const admin = read('includes/class-admin.php');
    const handler = admin.slice(admin.indexOf('public static function ajax_test'));
    expect(handler.indexOf('check_ajax_referer')).toBeGreaterThan(-1);
    expect(handler.indexOf('check_ajax_referer')).toBeLessThan(handler.indexOf('current_user_can'));
    expect(handler.indexOf('current_user_can')).toBeLessThan(handler.indexOf('$_POST'));
  });

  it('escape every echoed value on the settings page', () => {
    const admin = read('includes/class-admin.php');
    const page = admin.slice(admin.indexOf('public static function render_page'));
    const unescaped = [...page.matchAll(/<\?php\s+echo\s+([^;]+);\s*\?>/g)]
      .map((match) => match[1] as string)
      .filter((expression) => !/^\s*(esc_attr|esc_html|esc_url)\w*\(/.test(expression));
    expect(unescaped).toEqual([]);
  });

  it('write its settings only through the Settings API, and read its REST route for signed-in users only', () => {
    expect(read('includes/class-admin.php')).toContain(
      "'sanitize_callback' => array( Settings::class, 'sanitize' )",
    );
    const identity = read('includes/class-identity.php');
    expect(identity).toContain("'permission_callback' => array( __CLASS__, 'rest_permission' )");
    expect(identity).toContain('is_user_logged_in()');
    expect(identity).toContain("'no-store'");
    expect(identity).not.toContain('__return_true');
  });

  it('use PHP 7.4 syntax only, so the chat loads on older hosts', () => {
    for (const path of phpFiles) {
      const text = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const name = relative(plugin, path);
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
});

describe('the browser scripts', () => {
  it('write no HTML and run no dynamic code', () => {
    for (const name of ['assets/admin.js', 'assets/identity.js']) {
      expect(read(name), name).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/,
      );
    }
  });
});

describe('uninstall.php', () => {
  it('removes the option the settings are saved in, on one site and on every site of a network', () => {
    const settings = /const OPTION\s*=\s*'([^']+)'/.exec(read('includes/class-settings.php'))?.[1];
    const uninstall = read('uninstall.php');
    expect(settings).toBe('hamnivo_chat');
    expect(uninstall).toContain(`$hamnivo_chat_option = '${settings}';`);
    expect(uninstall).toContain('delete_option( $hamnivo_chat_option )');
    expect(uninstall).toContain('delete_site_option( $hamnivo_chat_option )');
    expect(uninstall).toContain('get_sites(');
    expect(uninstall).toContain("defined( 'WP_UNINSTALL_PLUGIN' )");
  });
});

describe('the SDK in the plugin', () => {
  it('is bundled by the build, and not copied into the source', () => {
    expect(existsSync(join(plugin, 'lib'))).toBe(false);
    expect(read('.gitignore')).toContain('lib/');
  });
});

describe('translations', () => {
  const php = spawnSync('php', ['-v'], { stdio: 'ignore' });
  it.skipIf(php.status !== 0)(
    'has a template that matches the strings in the code, and every text uses the text domain',
    () => {
      const result = spawnSync('php', [join(root, 'tools/make-pot.php'), '--check'], {
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\d+ strings, and languages\/hamnivo-chat\.pot is up to date/);
    },
  );

  it('has a template with a header and one entry per string', () => {
    const pot = read('languages/hamnivo-chat.pot');
    expect(pot).toContain('"Project-Id-Version: Hamnivo Chat ');
    expect(pot).toContain('"X-Domain: hamnivo-chat\\n"');
    // An entry is its context, if it has one, and its text.
    const entries: string[] = [];
    let context = '';
    for (const line of pot.split('\n')) {
      if (line.startsWith('msgctxt ')) context = line;
      else if (line.startsWith('msgid ') && line !== 'msgid ""') {
        entries.push(`${context}|${line}`);
        context = '';
      }
    }
    expect(entries.length).toBeGreaterThan(50);
    expect(new Set(entries).size).toBe(entries.length);
  });
});
