#!/usr/bin/env node
// Picks the suites of a CI run (.github/workflows/ci.yml, ADR 0009) and prints them as JSON for the
// workflow's matrix: a list of {id, name, args, pg, browsers}, one job each, each job running one
// part of `pnpm ci:local`.
//
//   node scripts/ci/plan.mjs
//
// It reads GITHUB_EVENT_NAME, GITHUB_REF and GITHUB_SHA; PASSED=true when an earlier run passed on
// the same tree (fkirc/skip-duplicate-actions); and BASE, what a branch is compared with
// (origin/main).
//
// - A run by hand, the nightly run and a push to main check everything: PostgreSQL 16 and 18 and
//   the smoke tests. A push to main whose tree already passed runs only PostgreSQL 16 and the smoke
//   tests, which a branch does not always run.
// - A push to another branch whose tree already passed runs nothing. Any other branch push tests
//   PostgreSQL 18, runs the smoke tests when a deploy file changes, and runs only the suites that
//   its change reaches in turbo's package graph; the basics typecheck and unit-test only the
//   packages it reaches. A change to Markdown or docs/ alone runs only the basics.
// - What it cannot place runs everything: no merge base, a changed file outside every package
//   (the workflows, scripts/ci, the lockfile, the root config, deploy/), or turbo failing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SMOKE =
  /^(deploy\/|scripts\/ci\/(production|autodeploy)-smoke\.sh$|\.github\/workflows\/ci\.yml$)/;
const DOCS = /(^docs\/|\.md$)/;
const ALL = ['basics', 'integration', 'chatwoot', 'accessibility', 'widget', 'studio', 'website'];
// The packages a suite tests: the app, and what its test stack runs (apps/*/e2e/stack.ts serves
// the gateway, the widget and the loader). Integration runs for any package with test:int.
const TESTS = {
  studio: ['@hamnivo/console', '@hamnivo/gateway', '@hamnivo/widget', '@hamnivo/widget-loader'],
  widget: ['@hamnivo/widget', '@hamnivo/gateway', '@hamnivo/widget-loader'],
  accessibility: ['@hamnivo/ui', '@hamnivo/brand'],
  website: ['@hamnivo/site'],
  chatwoot: ['@hamnivo/chatwoot'],
};
const PARTS = [1, 2, 3];

/**
 * What a run checks. `diff()` returns the files a branch changed, or null without a merge base;
 * `reach(files)` returns the packages those files reach, as {name, testInt}, and throws when it
 * cannot tell.
 */
export function pick({ event, ref, passed, diff, reach }) {
  const everything = (pg, smoke, why) => ({ pg, smoke, run: new Set(ALL), affected: false, why });
  if (event !== 'push') return everything(['16', '18'], true, `a ${event} run checks everything`);
  if (ref === 'refs/heads/main') {
    if (!passed) return everything(['16', '18'], true, 'a push to main checks everything');
    return {
      pg: ['16'],
      smoke: true,
      run: new Set(['integration']),
      affected: false,
      why: 'this tree passed on a branch: only what a branch does not always run',
    };
  }
  if (passed)
    return { pg: [], smoke: false, run: new Set(), affected: false, why: 'this tree passed' };

  const changed = diff();
  if (!changed) return everything(['18'], true, 'no merge base to compare with');
  const smoke = changed.some((file) => SMOKE.test(file));
  const code = changed.filter((file) => !DOCS.test(file));
  if (code.length === 0) {
    return {
      pg: ['18'],
      smoke,
      run: new Set(['basics']),
      affected: true,
      why: 'only docs changed',
    };
  }
  let reached;
  try {
    reached = reach(code);
  } catch (error) {
    return everything(['18'], smoke, `${error.message}: everything`);
  }
  const run = new Set(['basics']);
  if (reached.some((pkg) => pkg.testInt)) run.add('integration');
  for (const [suite, names] of Object.entries(TESTS)) {
    if (reached.some((pkg) => names.includes(pkg.name))) run.add(suite);
  }
  const names = reached.map((pkg) => pkg.name).join(', ') || 'no package';
  return { pg: ['18'], smoke, run, affected: true, why: `the change reaches ${names}` };
}

/** The options that turn off every part of `pnpm ci:local` but the one named (all, if none). */
function only(part) {
  return ['basics', 'integration', 'chatwoot', 'a11y', 'widget', 'studio', 'site']
    .filter((name) => name !== part)
    .map((name) => `--skip-${name} `)
    .join('');
}

/** The matrix for what `pick` chose. */
export function suites({ pg, smoke, run, affected }) {
  const list = [];
  const add = (id, name, args, browsers = false, version = '') =>
    list.push({ id, name, args, pg: version, browsers });
  if (run.has('studio')) {
    // Studio's 124 browser tests run on one worker, about 34 minutes: three parts instead.
    for (const part of PARTS) {
      add(
        `studio-${part}`,
        `Studio in a browser (part ${part} of 3)`,
        `${only('studio')}--shard=${part}/3`,
        true,
      );
    }
  }
  if (run.has('widget')) add('widget', 'Widget journey in a browser', only('widget'), true);
  if (smoke) {
    add('autodeploy-smoke', 'Automatic deploy smoke test', `${only()}--with-autodeploy`);
    add('production-smoke', 'Production deployment smoke test', `${only()}--with-production`, true);
  }
  // Each PostgreSQL version's integration tests in three parts, each with its own database.
  if (run.has('integration')) {
    for (const version of pg) {
      for (const part of PARTS) {
        const name = `Integration tests (PostgreSQL ${version}, part ${part} of 3)`;
        add(
          `integration-pg${version}-${part}`,
          name,
          `${only('integration')}--shard=${part}/3`,
          false,
          version,
        );
      }
    }
  }
  if (run.has('basics')) {
    add('basics', 'Lint, types and unit tests', affected ? '--quick --affected' : '--quick');
  }
  if (run.has('chatwoot')) add('chatwoot', 'Chatwoot contract suite', only('chatwoot'));
  if (run.has('accessibility')) add('accessibility', 'Accessibility audit', only('a11y'), true);
  if (run.has('website')) add('website', 'Website in a browser', only('site'), true);
  return list;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const selection = pick({
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    passed: env.PASSED === 'true',
    diff: () => changedFiles(env.BASE || 'origin/main', env.GITHUB_SHA || 'HEAD'),
    reach: reachInGraph,
  });
  const list = suites(selection);
  console.error(`Suites (${selection.why}): ${list.map((suite) => suite.id).join(' ') || 'none'}`);
  process.stdout.write(`${JSON.stringify(list)}\n`);
}
