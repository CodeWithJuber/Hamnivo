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
const ids = (selection) => suites(selection).map((suite) => suite.id);
const studio = ['studio-1', 'studio-2', 'studio-3'];
const integration = (version) => [1, 2, 3].map((part) => `integration-pg${version}-${part}`);
const smoke = ['autodeploy-smoke', 'production-smoke'];
// Every suite, in the order `suites` lists them, with or without the smoke tests.
const everything = (pg, withSmoke) => [
  ...studio,
  'widget',
  ...(withSmoke ? smoke : []),
  ...pg.flatMap(integration),
  'basics',
  'chatwoot',
  'accessibility',
  'website',
];

// A pull request is compared with main; main after a merge with the last commit a run passed on it.
const pr = (diff) => ({ event: 'pull_request', ref: 'refs/pull/7/merge', diff, reach });
const main = (diff) => ({ event: 'push', ref: 'refs/heads/main', diff, reach });
const failing = () => {
  throw new Error('turbo failed');
};
const basics = (selection) => suites(selection).find((s) => s.id === 'basics');
const basicsArgs = (selection) => basics(selection).args;

test('a pull request gets lint, types, unit and integration tests, and the suites it reaches', () => {
  // A change to Markdown or docs/ alone: the basics, on what it reaches.
  const docs = pick(pr(() => ['docs/a.md', 'apps/console/README.md']));
  assert.deepEqual(ids(docs), ['basics']);
  assert.equal(basicsArgs(docs), '--quick --affected');
  assert.equal(basics(docs).name, 'Lint, types and unit tests');
  assert.deepEqual(ids(pick(pr(() => ['apps/console/src/a.ts']))), [
    ...studio,
    ...integration('18'),
    'basics',
  ]);
  assert.deepEqual(ids(pick(pr(() => ['apps/gateway/src/a.ts']))), [
    ...studio,
    'widget',
    ...integration('18'),
    'basics',
  ]);
  assert.deepEqual(ids(pick(pr(() => ['packages/ui/src/a.tsx']))), [
    ...studio,
    'widget',
    ...integration('18'),
    'basics',
    'accessibility',
  ]);
  assert.deepEqual(ids(pick(pr(() => ['packages/chatwoot/src/a.ts']))), [
    ...studio,
    'widget',
    ...integration('18'),
    'basics',
    'chatwoot',
  ]);
  // Typecheck and unit tests only on the packages the change reaches; lint on everything.
  assert.equal(basicsArgs(pick(pr(() => ['apps/gateway/src/a.ts']))), '--quick --affected');
});

test('a pull request it cannot place gets every suite, but never a smoke test', () => {
  const full = everything(['18'], false);
  for (const files of [
    ['deploy/compose/a.yml'],
    ['apps/console/src/a.ts', 'pnpm-lock.yaml'],
    ['apps/console/src/a.ts', '.github/workflows/ci.yml'],
    ['scripts/ci/production-smoke.sh'],
  ]) {
    const selection = pick(pr(() => files));
    assert.deepEqual(ids(selection), full, files.join(' '));
    assert.equal(basicsArgs(selection), '--quick', files.join(' '));
  }
  assert.deepEqual(ids(pick({ ...pr(() => ['apps/console/a.ts']), reach: failing })), full);
  assert.deepEqual(ids(pick(pr(() => null))), full);
});

test('main after a merge runs the suites the merge reaches since the last commit it passed', () => {
  assert.deepEqual(ids(pick(main(() => ['docs/a.md', 'apps/console/README.md']))), ['basics']);
  assert.deepEqual(ids(pick(main(() => ['apps/console/src/a.ts']))), [...studio, 'basics']);
  assert.deepEqual(ids(pick(main(() => ['apps/gateway/src/a.ts']))), [
    ...studio,
    'widget',
    ...integration('18'),
    'basics',
  ]);
  assert.deepEqual(ids(pick(main(() => ['packages/ui/src/a.tsx']))), [
    ...studio,
    'widget',
    'basics',
    'accessibility',
  ]);
  // Main lints, typechecks and unit-tests every package, whatever the merge reached.
  const selection = pick(main(() => ['apps/console/src/a.ts']));
  assert.equal(basicsArgs(selection), '--quick');
  assert.equal(basics(selection).name, 'Lint, types and unit tests');
});

test('main runs everything when the merge cannot be placed, and the smoke tests for deploy files', () => {
  assert.deepEqual(ids(pick(main(() => ['deploy/compose/a.yml']))), everything(['18'], true));
  for (const file of ['pnpm-lock.yaml', 'turbo.json', 'scripts/ci/local.sh', '.github/x.yml']) {
    const selection = pick(main(() => ['apps/console/src/a.ts', file]));
    assert.deepEqual(ids(selection), everything(['18'], false), file);
    assert.equal(basicsArgs(selection), '--quick', file);
  }
  for (const file of ['scripts/ci/production-smoke.sh', '.github/workflows/ci.yml']) {
    assert.deepEqual(ids(pick(main(() => [file]))), everything(['18'], true), file);
  }
  assert.deepEqual(
    ids(pick({ ...main(() => ['apps/console/a.ts']), reach: failing })),
    everything(['18'], false),
  );
  // No commit to compare with (no run passed yet, or the lookup failed): everything.
  assert.deepEqual(ids(pick(main(() => null))), everything(['18'], true));
});

test('the weekly run and a run by hand check everything, on both PostgreSQL versions', () => {
  const unused = () => assert.fail('no diff is needed');
  for (const event of ['schedule', 'workflow_dispatch']) {
    for (const ref of ['refs/heads/main', 'refs/heads/topic']) {
      const selection = pick({ event, ref, diff: unused, reach });
      assert.deepEqual(ids(selection), everything(['16', '18'], true), `${event} ${ref}`);
      assert.equal(basicsArgs(selection), '--quick');
    }
  }
});

test('every run lints, and only the browser suites install browsers', () => {
  const unused = () => assert.fail('no diff is needed');
  const runs = [
    pr(() => ['docs/a.md']),
    pr(() => ['apps/console/src/a.ts']),
    pr(() => ['deploy/compose/a.yml']),
    main(() => ['apps/gateway/src/a.ts']),
    main(() => ['deploy/compose/a.yml']),
    { event: 'schedule', ref: 'refs/heads/main', diff: unused, reach },
    { event: 'workflow_dispatch', ref: 'refs/heads/topic', diff: unused, reach },
  ];
  const browsers = new Set([...studio, 'widget', 'accessibility', 'website', 'production-smoke']);
  for (const run of runs) {
    for (const suite of suites(pick(run))) {
      const where = `${run.event} ${run.ref}: ${suite.id}`;
      assert.ok(!suite.args.split(' ').includes('--skip-lint'), `${where} skips lint`);
      assert.equal(suite.browsers, browsers.has(suite.id), `${where} browsers`);
      if (run.event === 'pull_request') {
        assert.ok(!suite.id.endsWith('-smoke'), `${where} on a pull request`);
      }
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
