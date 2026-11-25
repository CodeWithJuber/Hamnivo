import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pick, suites } from './plan.mjs';

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

// A pull request opening, reopening or marked ready for review: its merge with main.
const pr = (diff, draft = false) => ({
  event: 'pull_request',
  ref: 'refs/pull/1/merge',
  passed: false,
  draft,
  diff,
  reach,
});
const failing = () => {
  throw new Error('turbo failed');
};

test('a branch push runs only the quick checks, on what its change reaches', () => {
  for (const files of [
    ['docs/a.md', 'apps/console/README.md'],
    ['apps/console/src/a.ts'],
    ['apps/gateway/src/a.ts'],
    ['packages/ui/src/a.tsx'],
  ]) {
    const list = suites(pick(branch(() => files)));
    assert.deepEqual(
      list.map((suite) => suite.id),
      ['basics'],
      files.join(' '),
    );
    assert.equal(list[0].args, '--quick --affected --skip-lint', files.join(' '));
  }
  // A change it cannot place still gets only the quick checks, on everything, and no smoke test.
  for (const files of [
    ['deploy/compose/a.yml'],
    ['apps/console/src/a.ts', 'pnpm-lock.yaml'],
    ['apps/console/src/a.ts', '.github/x.yml'],
  ]) {
    const list = suites(pick(branch(() => files)));
    assert.deepEqual(
      list.map((suite) => suite.id),
      ['basics'],
      files.join(' '),
    );
    assert.equal(list[0].args, '--quick --skip-lint', files.join(' '));
  }
  assert.deepEqual(ids(pick({ ...branch(() => ['apps/console/a.ts']), reach: failing })), [
    'basics',
  ]);
  assert.deepEqual(ids(pick(branch(() => null))), ['basics']);
});

test('a draft pull request runs only the quick checks', () => {
  assert.deepEqual(ids(pick(pr(() => ['apps/gateway/src/a.ts'], true))), ['basics']);
});

test('a pull request runs only the suites its change reaches, with the basics on what it reaches', () => {
  assert.deepEqual(ids(pick(pr(() => ['docs/a.md', 'apps/console/README.md']))), ['basics']);
  assert.deepEqual(ids(pick(pr(() => ['apps/console/src/a.ts']))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'basics',
  ]);
  assert.deepEqual(ids(pick(pr(() => ['apps/gateway/src/a.ts']))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'widget',
    'integration-pg18-1',
    'integration-pg18-2',
    'integration-pg18-3',
    'basics',
  ]);
  assert.deepEqual(ids(pick(pr(() => ['packages/ui/src/a.tsx']))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'widget',
    'basics',
    'accessibility',
  ]);
  const basics = suites(pick(pr(() => ['apps/console/src/a.ts']))).find((s) => s.id === 'basics');
  assert.equal(basics.args, '--quick --affected --skip-lint');
  // A branch's quick checks may have passed on this tree: the pull request still runs its suites.
  assert.deepEqual(ids(pick({ ...pr(() => ['apps/console/src/a.ts']), passed: true })), [
    'studio-1',
    'studio-2',
    'studio-3',
    'basics',
  ]);
});

test('a pull request runs everything when the change cannot be placed', () => {
  const full = everything(['18']);
  assert.deepEqual(ids(pick(pr(() => ['deploy/compose/a.yml']))), [
    ...full.slice(0, 4),
    ...smoke,
    ...full.slice(4),
  ]);
  for (const file of ['pnpm-lock.yaml', 'turbo.json', 'scripts/ci/local.sh', '.github/x.yml']) {
    const selection = pick(pr(() => ['apps/console/src/a.ts', file]));
    assert.deepEqual(ids(selection), full, file);
    assert.equal(suites(selection).find((s) => s.id === 'basics').args, '--quick --skip-lint');
  }
  assert.deepEqual(ids(pick({ ...pr(() => ['apps/console/a.ts']), reach: failing })), full);
  assert.deepEqual(ids(pick(pr(() => null))), [...full.slice(0, 4), ...smoke, ...full.slice(4)]);
});

test('main, the nightly run and a run by hand check everything; a branch tree is not checked twice', () => {
  const full = everything(['16', '18']);
  const all = [...full.slice(0, 4), ...smoke, ...full.slice(4)];
  const unused = () => assert.fail('no diff is needed');
  for (const event of ['schedule', 'workflow_dispatch']) {
    assert.deepEqual(
      ids(pick({ event, ref: 'refs/heads/main', passed: true, diff: unused, reach })),
      all,
    );
  }
  // A branch now passes on its quick checks alone, so a passed tree says nothing about main's suites.
  const main = { event: 'push', ref: 'refs/heads/main', diff: unused, reach };
  assert.deepEqual(ids(pick({ ...main, passed: false })), all);
  assert.deepEqual(ids(pick({ ...main, passed: true })), all);
  assert.deepEqual(ids(pick({ ...branch(unused), passed: true })), []);
});

test('lint runs only on main, the nightly run and a run by hand', () => {
  const unused = () => assert.fail('no diff is needed');
  const basicsArgs = (selection) => suites(selection).find((s) => s.id === 'basics').args;
  for (const event of ['schedule', 'workflow_dispatch']) {
    assert.equal(
      basicsArgs(pick({ event, ref: 'refs/heads/topic', diff: unused, reach })),
      '--quick',
    );
  }
  assert.equal(
    basicsArgs(pick({ event: 'push', ref: 'refs/heads/main', passed: true, diff: unused, reach })),
    '--quick',
  );
  assert.match(basicsArgs(pick(branch(() => ['apps/console/src/a.ts']))), /--skip-lint$/);
  assert.match(basicsArgs(pick(pr(() => ['apps/console/src/a.ts']))), /--skip-lint$/);
  assert.match(basicsArgs(pick(pr(() => ['pnpm-lock.yaml']))), /--skip-lint$/);
});
