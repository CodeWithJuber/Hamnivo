#!/usr/bin/env node
// Picks the suites of a CI run (.github/workflows/ci.yml, ADR 0009) and prints them as JSON for the
// workflow's matrix: a list of {id, name, args, pg}, one job each, each job running one part of
// `pnpm ci:local`.
//
//   node scripts/ci/plan.mjs
//
// It reads GITHUB_EVENT_NAME, GITHUB_REF and GITHUB_SHA; PASSED=true when an earlier run passed on
// the same tree (fkirc/skip-duplicate-actions); and BASE, what a change is compared with: for a
// push to main, the last commit a run of this workflow passed on main (`--last-passed` picks it from
// GitHub's list of the workflow's successful runs), origin/main for another branch. Without a BASE
// it cannot place the change.
//
//   node scripts/ci/plan.mjs --last-passed < runs.json
//
// CI runs on a small server, so it runs no browser suite (accessibility, the widget journey,
// Studio, the website), no lint (Biome, shellcheck) and no production smoke test, which drives
// Studio in a browser. They stay in `pnpm ci:local`, to run by hand. What it runs:
// - A push to another branch runs only typecheck and unit tests, on the packages its change
//   reaches in turbo's package graph, and nothing when its tree already passed. Agents push a
//   branch many times.
// - A push to main (a merge) runs the integration and Chatwoot suites reached since the last commit
//   main passed, so a suite that failed on one merge runs again on the next until it passes, on
//   PostgreSQL 18, and the quick checks on every package. It does not trust a passed tree, since a
//   branch passes on its quick checks. A change to Markdown or docs/ alone runs only the basics.
// - The weekly run and a run by hand check everything: PostgreSQL 16 and 18 and the automatic-deploy
//   smoke test, which builds the images and so never runs on a push.
// - What a change cannot place runs everything but the smoke test on main (no commit before it, a
//   changed file outside every package: the workflows, scripts/ci, the lockfile, the root config,
//   deploy/; or turbo failing), and the quick checks on every package on another branch.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOCS = /(^docs\/|\.md$)/;
const ALL = ['basics', 'integration', 'chatwoot'];
// The packages a suite tests. Integration runs for any package with test:int.
const TESTS = {
  chatwoot: ['@hamnivo/chatwoot'],
};
const PARTS = [1, 2, 3];

/**
 * What a run checks. `diff()` returns the files a branch changed, or null without a merge base;
 * `reach(files)` returns the packages those files reach, as {name, testInt}, and throws when it
 * cannot tell. Only the weekly run and a run by hand get the smoke test.
 */
export function pick({ event, ref, passed, diff, reach }) {
  const everything = (pg, smoke, why) => ({ pg, smoke, run: new Set(ALL), affected: false, why });
  if (event === 'push' && ref === 'refs/heads/main') {
    // The quick checks cover every package on main, whatever the merge reached.
    const merged = reachedSuites(diff, reach, everything);
    return { ...merged, affected: false, why: `main after a merge: ${merged.why}` };
  }
  if (event === 'push') {
    if (passed)
      return { pg: [], smoke: false, run: new Set(), affected: false, why: 'this tree passed' };
    const placed = reachedSuites(diff, reach, everything);
    return {
      pg: [],
      smoke: false,
      run: new Set(['basics']),
      affected: placed.affected,
      why: 'a branch push: types and unit tests; the heavy suites run on main after the merge',
    };
  }
  return everything(['16', '18'], true, `a ${event} run checks everything`);
}

/** The suites a change reaches; `everything` for a change it cannot place. Never a smoke test. */
function reachedSuites(diff, reach, everything) {
  const changed = diff();
  if (!changed) return everything(['18'], false, 'no merge base to compare with');
  const code = changed.filter((file) => !DOCS.test(file));
  if (code.length === 0) {
    return {
      pg: ['18'],
      smoke: false,
      run: new Set(['basics']),
      affected: true,
      why: 'only docs changed',
    };
  }
  let reached;
  try {
    reached = reach(code);
  } catch (error) {
    return everything(['18'], false, `${error.message}: everything`);
  }
  const run = new Set(['basics']);
  if (reached.some((pkg) => pkg.testInt)) run.add('integration');
  for (const [suite, names] of Object.entries(TESTS)) {
    if (reached.some((pkg) => names.includes(pkg.name))) run.add(suite);
  }
  const names = reached.map((pkg) => pkg.name).join(', ') || 'no package';
  return { pg: ['18'], smoke: false, run, affected: true, why: `the change reaches ${names}` };
}

/**
 * The options that turn off every part of `pnpm ci:local` but the one named (all, if none). The
 * browser parts (a11y, widget, studio, site) are never named, so no CI job starts a browser.
 */
function only(part) {
  return ['basics', 'integration', 'chatwoot', 'a11y', 'widget', 'studio', 'site']
    .filter((name) => name !== part)
    .map((name) => `--skip-${name} `)
    .join('');
}

/** The matrix for what `pick` chose. */
export function suites({ pg, smoke, run, affected }) {
  const list = [];
  const add = (id, name, args, version = '') => list.push({ id, name, args, pg: version });
  // Production's smoke test (--with-production) also drives Studio in Chromium, so CI leaves it to
  // a run of `pnpm ci:local` by hand.
  if (smoke) add('autodeploy-smoke', 'Automatic deploy smoke test', `${only()}--with-autodeploy`);
  // Each PostgreSQL version's integration tests in three parts, each with its own database.
  if (run.has('integration')) {
    for (const version of pg) {
      for (const part of PARTS) {
        const name = `Integration tests (PostgreSQL ${version}, part ${part} of 3)`;
        add(
          `integration-pg${version}-${part}`,
          name,
          `${only('integration')}--shard=${part}/3`,
          version,
        );
      }
    }
  }
  if (run.has('basics')) {
    // No lint (Biome, shellcheck) in CI: `pnpm lint` before a push, or `pnpm ci:local --quick`.
    const args = `${affected ? '--quick --affected' : '--quick'} --skip-lint`;
    add('basics', 'Types and unit tests', args);
  }
  if (run.has('chatwoot')) add('chatwoot', 'Chatwoot contract suite', only('chatwoot'));
  return list;
}

/** The newest commit a run passed, from GitHub's list of this workflow's runs, newest first. */
export function lastPassed(answer) {
  const full = ['push', 'schedule', 'workflow_dispatch'];
  const run = (answer?.workflow_runs ?? []).find(
    (item) => full.includes(item.event) && item.conclusion === 'success' && item.head_sha,
  );
  return run ? run.head_sha : null;
}

function changedFiles(base, sha) {
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${base}...${sha}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function turboPackages(filters) {
  const output = execFileSync('pnpm', ['exec', 'turbo', 'ls', ...filters, '--output=json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
  });
  return JSON.parse(output).packages.items;
}

/** The packages that hold `files` and every package that depends on them, from turbo's graph. */
function reachInGraph(files) {
  const packages = turboPackages([]);
  const holders = new Set();
  for (const file of files) {
    const holder = packages
      .filter((pkg) => file.startsWith(`${pkg.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!holder) throw new Error(`${file} is in no package`);
    holders.add(holder.name);
  }
  return turboPackages([...holders].map((name) => `--filter=...${name}`)).map((pkg) => ({
    name: pkg.name,
    testInt: Boolean(
      JSON.parse(readFileSync(`${pkg.path}/package.json`, 'utf8')).scripts?.['test:int'],
    ),
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--last-passed') {
  const sha = lastPassed(JSON.parse(readFileSync(0, 'utf8')));
  if (!sha) {
    console.error('No run of this workflow passed on this branch');
    process.exit(1);
  }
  process.stdout.write(`${sha}\n`);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const selection = pick({
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    passed: env.PASSED === 'true',
    diff: () => (env.BASE ? changedFiles(env.BASE, env.GITHUB_SHA || 'HEAD') : null),
    reach: reachInGraph,
  });
  const list = suites(selection);
  console.error(`Suites (${selection.why}): ${list.map((suite) => suite.id).join(' ') || 'none'}`);
  process.stdout.write(`${JSON.stringify(list)}\n`);
}
