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
const everything = (pg) => [
  'studio-1',
  'studio-2',
  'studio-3',
  'widget',
  ...pg.flatMap((version) => [1, 2, 3].map((part) => `integration-pg${version}-${part}`)),
  'basics',
  'chatwoot',
  'accessibility',
  'website',
];
const smoke = ['autodeploy-smoke', 'production-smoke'];

// main after a merge: compared with main before it (github.event.before).
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
const basicsArgs = (selection) => suites(selection).find((s) => s.id === 'basics').args;

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

test('main after a merge runs the heavy suites the merge reaches, once', () => {
  assert.deepEqual(ids(pick(main(() => ['docs/a.md', 'apps/console/README.md']))), ['basics']);
  assert.deepEqual(ids(pick(main(() => ['apps/console/src/a.ts']))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'basics',
  ]);
  assert.deepEqual(ids(pick(main(() => ['apps/gateway/src/a.ts']))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'widget',
    'integration-pg18-1',
    'integration-pg18-2',
    'integration-pg18-3',
    'basics',
  ]);
  assert.deepEqual(ids(pick(main(() => ['packages/ui/src/a.tsx']))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'widget',
    'basics',
    'accessibility',
  ]);
  // Main lints and runs the quick checks on every package, whatever the merge reached.
  assert.equal(basicsArgs(pick(main(() => ['apps/console/src/a.ts']))), '--quick');
  // A tree a branch passed on its quick checks says nothing about the heavy suites.
  assert.deepEqual(ids(pick(main(() => ['apps/console/src/a.ts'], true))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'basics',
  ]);
});

test('main runs everything when the merge cannot be placed', () => {
  const full = everything(['18']);
  assert.deepEqual(ids(pick(main(() => ['deploy/compose/a.yml']))), [
    ...full.slice(0, 4),
    ...smoke,
    ...full.slice(4),
  ]);
  for (const file of ['pnpm-lock.yaml', 'turbo.json', 'scripts/ci/local.sh', '.github/x.yml']) {
    const selection = pick(main(() => ['apps/console/src/a.ts', file]));
    assert.deepEqual(ids(selection), full, file);
    assert.equal(basicsArgs(selection), '--quick', file);
  }
  assert.deepEqual(ids(pick({ ...main(() => ['apps/console/a.ts']), reach: failing })), full);
  // No commit before (a new branch or a forced push): everything.
  assert.deepEqual(ids(pick(main(() => null))), [...full.slice(0, 4), ...smoke, ...full.slice(4)]);
});

test('the weekly run and a run by hand check everything, with lint', () => {
  const full = everything(['16', '18']);
  const all = [...full.slice(0, 4), ...smoke, ...full.slice(4)];
  const unused = () => assert.fail('no diff is needed');
  for (const event of ['schedule', 'workflow_dispatch']) {
    const selection = pick({ event, ref: 'refs/heads/main', passed: true, diff: unused, reach });
    assert.deepEqual(ids(selection), all);
    assert.equal(basicsArgs(selection), '--quick');
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
