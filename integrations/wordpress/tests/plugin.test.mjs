/**
 * The plugin inside WordPress, on each PHP version it supports.
 *
 *   node --test integrations/wordpress/tests/plugin.test.mjs
 *   HAMNIVO_PHP_VERSIONS=7.4,8.1,8.3,8.5 node --test integrations/wordpress/tests/plugin.test.mjs
 *
 * It builds the plugin zip, unpacks it, and runs tests/php/suite.php in WordPress Playground (see
 * playground.mjs). The first run downloads WordPress; later runs are cached.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { installBuiltPlugin, runPhp } from './playground.mjs';

const versions = (process.env.HAMNIVO_PHP_VERSIONS ?? '8.3,7.4').split(',').map((v) => v.trim());
let plugin = '';

before(() => {
  plugin = installBuiltPlugin();
});

for (const php of versions) {
  describe(`the WordPress plugin on PHP ${php}`, () => {
    it('passes every test', { timeout: 600_000 }, () => {
      const { status, stdout, stderr } = runPhp({ plugin, php, script: 'php/suite.php' });
      const lines = stdout.split('\n');
      const failed = lines.filter((line) => line.startsWith('not ok'));
      const summary = lines.find((line) => /^# \d+ tests, \d+ failed$/.test(line)) ?? '';
      const count = Number(/^# (\d+) tests/.exec(summary)?.[1] ?? 0);
      const skipped = lines.filter((line) => line.includes('# SKIP')).length;
      const runtime = lines.find((line) => line.startsWith('# PHP ')) ?? '';
      process.stdout.write(
        `${runtime.slice(2)}: ${summary.slice(2) || 'no summary'}, ${skipped} skipped\n`,
      );
      assert.ok(
        runtime.startsWith(`# PHP ${php}.`),
        `Playground ran ${runtime || 'something else'}, not PHP ${php}`,
      );

      assert.equal(failed.length, 0, `${failed.join('\n')}\n\n${stdout}\n${stderr}`);
      assert.equal(status, 0, `${stdout}\n${stderr}`);
      assert.ok(count >= 50, `only ${count} tests ran:\n${stdout}\n${stderr}`);
      // Newer PHP runs everything but the test for old PHP. Old PHP skips the tests of signing.
      const expectedSkips =
        Number(php.split('.')[0]) * 100 + Number(php.split('.')[1]) >= 801 ? 1 : 14;
      assert.ok(
        skipped <= expectedSkips,
        `${skipped} tests were skipped on PHP ${php}, expected at most ${expectedSkips}.\n${stdout}`,
      );
      assert.ok(
        !/PHP (Warning|Fatal error|Parse error|Notice|Deprecated)/.test(stdout + stderr),
        `PHP complained:\n${stdout}\n${stderr}`,
      );
    });
  });
}
