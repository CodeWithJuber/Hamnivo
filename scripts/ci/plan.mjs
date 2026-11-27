#!/usr/bin/env node
// Picks the suites of a CI run (.github/workflows/ci.yml, ADR 0021) and prints them as JSON for the
// workflow's matrix: a list of {id, name, args, pg, browsers}, one job each, each job running one
// part of `pnpm ci:local` on a GitHub-hosted runner.
//
//   node scripts/ci/plan.mjs
//
// It reads GITHUB_EVENT_NAME, GITHUB_REF and GITHUB_SHA, and BASE, what a change is compared with:
// origin/main for a pull request; for a push to main, the last commit a run of this workflow passed
// on main (`--last-passed` picks it from GitHub's list of the workflow's successful runs). Without
// a BASE it cannot place the change.
//
//   node scripts/ci/plan.mjs --last-passed < runs.json
//
// Every run lints (Biome, shellcheck). What else it runs:
// - A pull request: typecheck and unit tests on the packages its change reaches in turbo's package
//   graph, the integration tests on PostgreSQL 18, and the other suites the change reaches (the
//   Chatwoot contract suite, the accessibility audit, the widget journey, Studio in three parts,
//   the website). A change to Markdown or docs/ alone runs only the basics. Never a smoke test:
//   they build the production images.
// - A push to main (a merge): the suites reached since the last commit main passed, so a suite that
//   failed on one merge runs again on the next until it passes, on PostgreSQL 18; typecheck and unit
//   tests on every package; and the smoke tests when a deploy file changed.
// - The weekly run and a run by hand: everything, on PostgreSQL 16 and 18, with both smoke tests.
// - What a change cannot place (no commit to compare with, a changed file outside every package:
//   the workflows, scripts/ci, the lockfile, the root config, deploy/; or turbo failing) runs every
//   suite, with the smoke tests only on main.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SMOKE =
  /^(deploy\/|scripts\/ci\/(production|autodeploy)-smoke\.sh$|\.github\/workflows\/ci\.yml$)/;
const DOCS = /(^docs\/|\.md$)/;
const ALL = ['basics', 'integration', 'chatwoot', 'accessibility', 'widget', 'studio', 'website'];
// The packages a suite tests: the app, and what its test stack runs (apps/*/e2e/stack.ts serves
// the gateway, the widget and the loader). Integration runs for any package with test:int, and on
// every pull request that changes code.
const TESTS = {
  studio: ['@hamnivo/console', '@hamnivo/gateway', '@hamnivo/widget', '@hamnivo/widget-loader'],
  widget: ['@hamnivo/widget', '@hamnivo/gateway', '@hamnivo/widget-loader'],
  accessibility: ['@hamnivo/ui', '@hamnivo/brand'],
  website: ['@hamnivo/site'],
  chatwoot: ['@hamnivo/chatwoot'],
};
const PARTS = [1, 2, 3];

/**
 * What a run checks. `diff()` returns the files a change touched, or null without a commit to
 * compare with; `reach(files)` returns the packages those files reach, as {name, testInt}, and
 * throws when it cannot tell.
 */
export function pick({ event, ref, diff, reach }) {
  const everything = (pg, smoke, why) => ({ pg, smoke, run: new Set(ALL), affected: false, why });
  if (event === 'pull_request') {
    const placed = reachedSuites(diff, reach, everything);
    const run = new Set(placed.run);
    if (!placed.docsOnly) run.add('integration');
    return { ...placed, run, smoke: false, why: `a pull request: ${placed.why}` };
  }
  if (event === 'push' && ref === 'refs/heads/main') {
    // Typecheck and unit tests cover every package on main, whatever the merge reached.
    const merged = reachedSuites(diff, reach, everything);
    return { ...merged, affected: false, why: `main after a merge: ${merged.why}` };
  }
  return everything(['16', '18'], true, `a ${event} run checks everything`);
}

/** The suites a change reaches; `everything` for a change it cannot place. */
function reachedSuites(diff, reach, everything) {
  const changed = diff();
  if (!changed) return everything(['18'], true, 'no commit to compare with');
  const smoke = changed.some((file) => SMOKE.test(file));
  const code = changed.filter((file) => !DOCS.test(file));
  if (code.length === 0) {
    return {
      pg: ['18'],
      smoke,
      run: new Set(['basics']),
      affected: true,
      docsOnly: true,
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

/** The matrix for what `pick` chose. `browsers` tells the job to install Chromium and WebKit. */
export function suites({ pg, smoke, run, affected }) {
  const list = [];
  const add = (id, name, args, browsers = false, version = '') =>
    list.push({ id, name, args, pg: version, browsers });
  if (run.has('studio')) {
    // Studio's browser tests run on one worker, about 34 minutes: three parts instead.
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
    // Its last part drives Studio in Chromium.
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
    diff: () => (env.BASE ? changedFiles(env.BASE, env.GITHUB_SHA || 'HEAD') : null),
    reach: reachInGraph,
  });
  const list = suites(selection);
  console.error(`Suites (${selection.why}): ${list.map((suite) => suite.id).join(' ') || 'none'}`);
  process.stdout.write(`${JSON.stringify(list)}\n`);
}
