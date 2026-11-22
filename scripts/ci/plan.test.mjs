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

test('a branch runs only the suites its change reaches, with the basics on what it reaches', () => {
  assert.deepEqual(ids(pick(branch(() => ['docs/a.md', 'apps/console/README.md']))), ['basics']);
  assert.deepEqual(ids(pick(branch(() => ['apps/console/src/a.ts']))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'basics',
  ]);
  assert.deepEqual(ids(pick(branch(() => ['apps/gateway/src/a.ts']))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'widget',
    'integration-pg18-1',
    'integration-pg18-2',
    'integration-pg18-3',
    'basics',
  ]);
  assert.deepEqual(ids(pick(branch(() => ['packages/ui/src/a.tsx']))), [
    'studio-1',
    'studio-2',
    'studio-3',
    'widget',
    'basics',
    'accessibility',
  ]);
  const basics = suites(pick(branch(() => ['apps/console/src/a.ts']))).find(
    (s) => s.id === 'basics',
  );
  assert.equal(basics.args, '--quick --affected');
});

test('a branch runs everything when the change cannot be placed', () => {
  const full = everything(['18']);
  assert.deepEqual(ids(pick(branch(() => ['deploy/compose/a.yml']))), [
    ...full.slice(0, 4),
    ...smoke,
    ...full.slice(4),
  ]);
  for (const file of ['pnpm-lock.yaml', 'turbo.json', 'scripts/ci/local.sh', '.github/x.yml']) {
    const selection = pick(branch(() => ['apps/console/src/a.ts', file]));
    assert.deepEqual(ids(selection), full, file);
    assert.equal(suites(selection).find((s) => s.id === 'basics').args, '--quick');
  }
  const failing = () => {
    throw new Error('turbo failed');
  };
  assert.deepEqual(ids(pick({ ...branch(() => ['apps/console/a.ts']), reach: failing })), full);
  assert.deepEqual(ids(pick(branch(() => null))), [
    ...full.slice(0, 4),
    ...smoke,
    ...full.slice(4),
  ]);
});

test('main, the nightly run and a run by hand check everything; a passed tree is not checked twice', () => {
  const full = everything(['16', '18']);
  const all = [...full.slice(0, 4), ...smoke, ...full.slice(4)];
  const unused = () => assert.fail('no diff is needed');
  for (const event of ['schedule', 'workflow_dispatch']) {
    assert.deepEqual(
      ids(pick({ event, ref: 'refs/heads/main', passed: true, diff: unused, reach })),
      all,
    );
  }
  const main = { event: 'push', ref: 'refs/heads/main', diff: unused, reach };
  assert.deepEqual(ids(pick({ ...main, passed: false })), all);
  assert.deepEqual(ids(pick({ ...main, passed: true })), [
    ...smoke,
    'integration-pg16-1',
    'integration-pg16-2',
    'integration-pg16-3',
  ]);
  assert.deepEqual(ids(pick({ ...branch(unused), passed: true })), []);
});
