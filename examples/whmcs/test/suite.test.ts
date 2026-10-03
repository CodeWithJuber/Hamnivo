import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Runs the addon's own PHP tests with the PHP on this machine. WHMCS is a commercial product that
 * cannot be installed here, so tests/suite.php stands in for the few things the addon takes from
 * it (add_hook, generate_token, the database store, the session) and checks everything the addon
 * does with them: the settings, the loader and identity scripts, the identity address, the product
 * names, Test connection, and the admin page.
 *
 * Without PHP these tests are skipped. integrations/whmcs/modules/addons/hamnivo/tests/playground.test.mjs
 * runs the same suite on PHP 7.4 to 8.5 inside WordPress Playground, which needs no PHP of its own.
 */
const suite = join(
  import.meta.dirname,
  '../../../integrations/whmcs/modules/addons/hamnivo/tests/suite.php',
);
const php = spawnSync('php', ['-v'], { stdio: 'ignore' });

describe('the addon, with the PHP on this machine', () => {
  it.skipIf(php.status !== 0)('passes every test in tests/suite.php', () => {
    const result = spawnSync('php', [suite], { encoding: 'utf8' });
    const lines = result.stdout.split('\n');
    const failed = lines.filter((line) => line.startsWith('not ok'));
    const summary = lines.find((line) => /^# \d+ tests, \d+ failed, \d+ skipped$/.test(line)) ?? '';
    const count = Number(/^# (\d+) tests/.exec(summary)?.[1] ?? 0);
    expect(failed, `${result.stdout}\n${result.stderr}`).toEqual([]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(count).toBeGreaterThanOrEqual(50);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toMatch(/(Warning|Fatal error|Parse error|Notice|Deprecated):/);
  });
});
