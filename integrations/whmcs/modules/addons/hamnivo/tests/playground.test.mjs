/**
 * The WHMCS addon on each PHP version it supports.
 *
 *   node --test integrations/whmcs/modules/addons/hamnivo/tests/playground.test.mjs
 *   HAMNIVO_PHP_VERSIONS=7.4,8.1,8.3,8.5 node --test integrations/whmcs/modules/addons/hamnivo/tests/playground.test.mjs
 *
 * WHMCS is a commercial product that cannot be installed here, so tests/suite.php stands in for
 * the few things the addon takes from it. This file runs that suite on the built zip (with the SDK
 * bundled, as a customer gets it) in WordPress Playground, which has every PHP version from 7.4 on
 * as WebAssembly. The suite needs PHP and no WordPress, and Playground is only the way to get PHP.
 * See integrations/wordpress/tests/playground.mjs for how Playground is run.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { root, runScript } from '../../../../../wordpress/tests/playground.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const versions = (process.env.HAMNIVO_PHP_VERSIONS ?? '8.3,7.4').split(',').map((v) => v.trim());
let addon = '';

before(() => {
  execFileSync('bash', [join(root, 'scripts/build-integrations.sh'), 'whmcs'], {
    cwd: root,
    stdio: 'pipe',
  });
  const folder = mkdtempSync(join(tmpdir(), 'hamnivo-whmcs-'));
  execFileSync('unzip', [
    '-q',
    join(root, 'dist/integrations/hamnivo-whmcs-addon.zip'),
    '-d',
    folder,
  ]);
  addon = join(folder, 'modules/addons/hamnivo');
});

for (const php of versions) {
  describe(`the WHMCS addon on PHP ${php}`, () => {
    it('passes every test', { timeout: 600_000 }, () => {
      const { status, stdout, stderr } = runScript({
        php,
        script: '/tests/suite.php',
        mounts: [`${addon}:/addon`, `${here}:/tests`],
        defines: { HAMNIVO_ADDON_DIR: '/addon' },
      });
      const lines = stdout.split('\n');
      const failed = lines.filter((line) => line.startsWith('not ok'));
      const summary =
        lines.find((line) => /^# \d+ tests, \d+ failed, \d+ skipped$/.test(line)) ?? '';
      const count = Number(/^# (\d+) tests/.exec(summary)?.[1] ?? 0);
      const skipped = Number(/(\d+) skipped$/.exec(summary)?.[1] ?? 0);
      const runtime = lines.find((line) => line.startsWith('# PHP ')) ?? '';
      process.stdout.write(`${runtime.slice(2)}: ${summary.slice(2) || 'no summary'}\n`);
      assert.ok(
        runtime.startsWith(`# PHP ${php}.`),
        `Playground ran ${runtime || 'something else'}, not PHP ${php}`,
      );

      assert.equal(failed.length, 0, `${failed.join('\n')}\n\n${stdout}\n${stderr}`);
      assert.equal(status, 0, `${stdout}\n${stderr}`);
      assert.ok(count >= 50, `only ${count} tests ran:\n${stdout}\n${stderr}`);
      // PHP 8.1 and later run every test. Before it the SDK cannot load, so the tests that sign
      // are skipped, and the tests that the chat still loads and that clients stay anonymous run.
      const [major, minor] = php.split('.').map(Number);
      const expectedSkips = major * 100 + minor >= 801 ? 0 : 6;
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
