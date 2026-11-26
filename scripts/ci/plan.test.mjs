import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastPassed, pick, suites } from './plan.mjs';

// A small stand-in for turbo's graph: the package a path is in, and the packages it reaches.
const graph = {
  'apps/console': [{ name: '@hamnivo/console', testInt: false }],
  'apps/gateway': [{ name: '@hamnivo/gateway', testInt: true }],
  'packages/ui': [
    { name: '@hamnivo/ui', testInt: false },
    { name: '@hamnivo/console', testInt: false },
    { name: '@hamnivo/widget', testInt: false },
  ],
  'packages/chatwoot': [
    { name: '@hamnivo/chatwoot', testInt: true },
    { name: '@hamnivo/gateway', testInt: true },
  ],
};
function reach(files) {
  return files.flatMap((file) => {
    const found = graph[file.split('/').slice(0, 2).join('/')];
    if (!found) throw new Error(`${file} is in no package`);
    return found;
  });
}
const branch = (diff) => ({ event: 'push', ref: 'refs/heads/topic', passed: false, diff, reach });
const ids = (selection) => suites(selection).map((suite) => suite.id);
const integration = (version) => [1, 2, 3].map((part) => `integration-pg${version}-${part}`);
const everything = (pg) => [...pg.flatMap(integration), 'basics', 'chatwoot'];

// main after a merge: compared with the last commit a run passed on main.
const main = (diff, passed = false) => ({
  event: 'push',
  ref: 'refs/heads/main',
  passed,
  diff,
  reach,
});
const failing = () => {
  throw new Error('turbo failed');
};
const basics = (selection) => suites(selection).find((s) => s.id === 'basics');
const basicsArgs = (selection) => basics(selection).args;

test('a branch push runs only types and unit tests, on what its change reaches', () => {
  for (const files of [
    ['docs/a.md', 'apps/console/README.md'],
    ['apps/console/src/a.ts'],
    ['apps/gateway/src/a.ts'],
    ['packages/ui/src/a.tsx'],
  ]) {
    const selection = pick(branch(() => files));
    assert.deepEqual(ids(selection), ['basics'], files.join(' '));
    assert.equal(basicsArgs(selection), '--quick --affected --skip-lint', files.join(' '));
    assert.equal(basics(selection).name, 'Types and unit tests', files.join(' '));
  }
  // A change it cannot place gets the quick checks on every package, and no smoke test.
  for (const files of [
    ['deploy/compose/a.yml'],
    ['apps/console/src/a.ts', 'pnpm-lock.yaml'],
    ['apps/console/src/a.ts', '.github/x.yml'],
  ]) {
    const selection = pick(branch(() => files));
    assert.deepEqual(ids(selection), ['basics'], files.join(' '));
    assert.equal(basicsArgs(selection), '--quick --skip-lint', files.join(' '));
  }
  assert.deepEqual(ids(pick({ ...branch(() => ['apps/console/a.ts']), reach: failing })), [
    'basics',
  ]);
  assert.deepEqual(ids(pick(branch(() => null))), ['basics']);
  assert.deepEqual(ids(pick({ ...branch(() => assert.fail('no diff')), passed: true })), []);
});

test('main after a merge runs the integration and Chatwoot suites the merge reaches, once', () => {
  assert.deepEqual(ids(pick(main(() => ['docs/a.md', 'apps/console/README.md']))), ['basics']);
  // Studio, the widget and the UI kit have only browser suites beyond their unit tests.
  assert.deepEqual(ids(pick(main(() => ['apps/console/src/a.ts']))), ['basics']);
  assert.deepEqual(ids(pick(main(() => ['packages/ui/src/a.tsx']))), ['basics']);
  assert.deepEqual(ids(pick(main(() => ['apps/gateway/src/a.ts']))), [
    ...integration('18'),
    'basics',
  ]);
  assert.deepEqual(ids(pick(main(() => ['packages/chatwoot/src/a.ts']))), everything(['18']));
  // Main runs the quick checks on every package, whatever the merge reached, and never lints.
  const selection = pick(main(() => ['apps/console/src/a.ts']));
  assert.equal(basicsArgs(selection), '--quick --skip-lint');
  assert.equal(basics(selection).name, 'Types and unit tests');
  // A tree a branch passed on its quick checks says nothing about the integration tests.
  assert.deepEqual(ids(pick(main(() => ['apps/gateway/src/a.ts'], true))), [
    ...integration('18'),
    'basics',
  ]);
});

test('main runs everything but the smoke tests when the merge cannot be placed', () => {
  const full = everything(['18']);
  // A deploy file no longer brings the smoke tests to a push: they build images.
  assert.deepEqual(ids(pick(main(() => ['deploy/compose/a.yml']))), full);
  for (const file of ['pnpm-lock.yaml', 'turbo.json', 'scripts/ci/local.sh', '.github/x.yml']) {
    const selection = pick(main(() => ['apps/console/src/a.ts', file]));
    assert.deepEqual(ids(selection), full, file);
    assert.equal(basicsArgs(selection), '--quick --skip-lint', file);
  }
  assert.deepEqual(ids(pick({ ...main(() => ['apps/console/a.ts']), reach: failing })), full);
  // No commit before (a new branch or a forced push): everything.
  assert.deepEqual(ids(pick(main(() => null))), full);
});

test('the weekly run and a run by hand check everything, with the automatic-deploy smoke test', () => {
  const unused = () => assert.fail('no diff is needed');
  for (const event of ['schedule', 'workflow_dispatch']) {
    const selection = pick({ event, ref: 'refs/heads/main', passed: true, diff: unused, reach });
    assert.deepEqual(ids(selection), ['autodeploy-smoke', ...everything(['16', '18'])]);
    assert.equal(basicsArgs(selection), '--quick --skip-lint');
  }
});

test('no run starts a browser, lints, or builds the production smoke stack', () => {
  const unused = () => assert.fail('no diff is needed');
  const runs = [
    branch(() => ['apps/console/src/a.ts']),
    branch(() => ['deploy/compose/a.yml']),
    main(() => ['apps/console/src/a.ts']),
    main(() => ['packages/ui/src/a.tsx']),
    main(() => ['deploy/compose/a.yml']),
    main(() => null),
    { event: 'schedule', ref: 'refs/heads/main', passed: false, diff: unused, reach },
    { event: 'workflow_dispatch', ref: 'refs/heads/topic', passed: false, diff: unused, reach },
  ];
  // `pnpm ci:local` runs the browser suites unless --quick or a --skip option turns them off.
  const browsers = ['--skip-a11y', '--skip-widget', '--skip-studio', '--skip-site'];
  for (const run of runs) {
    for (const suite of suites(pick(run))) {
      const args = suite.args.split(' ');
      const where = `${run.event} ${run.ref}: ${suite.id}`;
      assert.ok(
        args.includes('--quick') || browsers.every((skip) => args.includes(skip)),
        `${where} runs a browser`,
      );
      assert.ok(args.includes('--skip-lint') || args.includes('--skip-basics'), `${where} lints`);
      assert.ok(!args.includes('--with-production'), `${where} runs the production smoke test`);
      if (run.event === 'push') assert.ok(!suite.id.endsWith('-smoke'), `${where} on a push`);
    }
  }
});

test('main is compared with the last commit a run passed, never a pull request or a failure', () => {
  // Newest first, as GitHub lists them.
  const runs = [
    { event: 'pull_request', conclusion: 'success', head_sha: 'pr' },
    { event: 'push', conclusion: 'failure', head_sha: 'failed' },
    { event: 'push', conclusion: 'success', head_sha: 'passed' },
    { event: 'schedule', conclusion: 'success', head_sha: 'weekly' },
  ];
  assert.equal(lastPassed({ workflow_runs: runs }), 'passed');
  assert.equal(lastPassed({ workflow_runs: runs.slice(0, 2) }), null);
  assert.equal(lastPassed({}), null);
});
