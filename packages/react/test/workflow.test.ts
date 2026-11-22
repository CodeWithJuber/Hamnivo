import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * .github/workflows/release-packages.yml publishes @hamnivo/react and @hamnivo/vue when a tag is
 * pushed. GitHub is the only place it runs, so these tests run its own script for reading the tag
 * (taken out of the file, not copied) and check the rest of what the file promises.
 */
const root = join(import.meta.dirname, '../../..');
const workflow = readFileSync(join(root, '.github/workflows/release-packages.yml'), 'utf8');

/** The shell script of one step, by the name of the step. */
function script(step: string): string {
  const start = workflow.indexOf(`      - name: ${step}\n`);
  const run = workflow.indexOf('        run: |\n', start);
  const end = workflow.indexOf('\n      - ', run);
  expect(start, step).toBeGreaterThan(-1);
  return workflow
    .slice(run + '        run: |\n'.length, end === -1 ? undefined : end)
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
}

function readTag(tag: string) {
  const output = join(mkdtempSync(join(tmpdir(), 'hamnivo-release-')), 'output');
  const result = spawnSync('bash', ['-c', script('Work out which package the tag is for')], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', TAG: tag, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  let outputs: Record<string, string> = {};
  try {
    outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  } catch {
    // Nothing was written, as when the tag is refused.
  }
  return { status: result.status, stdout: result.stdout, outputs };
}

const version = (name: string) =>
  (
    JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

describe('the tag', () => {
  it('names the package and its version, and the version has to be the one in package.json', () => {
    for (const name of ['react', 'vue']) {
      const run = readTag(`${name}-v${version(name)}`);
      expect(run.status, name).toBe(0);
      expect(run.outputs, name).toEqual({
        filter: `@hamnivo/${name}`,
        dir: `packages/${name}`,
        version: version(name),
        npm_tag: 'latest',
      });
    }
  });

  it('is refused when the version is not the one in package.json, with a message that says both', () => {
    const run = readTag('react-v9.9.9');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('The tag says 9.9.9, but packages/react/package.json says');
    expect(run.outputs).toEqual({});
  });

  it('is refused when it is not for react or vue, or is not a version', () => {
    for (const tag of [
      'server-v1.0.0',
      'client-v0.1.0',
      'react-v',
      'react-v1',
      'react-v1.0',
      'vue-vlatest',
    ]) {
      const run = readTag(tag);
      expect(run.status, tag).toBe(1);
      expect(run.stdout, tag).toContain('::error::');
      expect(run.outputs, tag).toEqual({});
    }
  });

  it('publishes a version with a dash under "next", so that it never becomes "latest"', () => {
    // Pretend package.json says the beta, by running the same script on a copy of it.
    const folder = mkdtempSync(join(tmpdir(), 'hamnivo-release-'));
    const output = join(folder, 'output');
    const beta = `${version('react')}-beta.1`;
    const result = spawnSync(
      'bash',
      [
        '-c',
        `mkdir -p packages/react && echo '{"version":"${beta}"}' > packages/react/package.json && ${script('Work out which package the tag is for')}`,
      ],
      {
        cwd: folder,
        env: { PATH: process.env.PATH ?? '', TAG: `react-v${beta}`, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stdout).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('npm_tag=next');
  });
});

describe('the workflow', () => {
  it('runs only for tags, and for no other event', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- 'react-v\*'\n {6}- 'vue-v\*'\n/m);
    expect(workflow).not.toMatch(/branches:|pull_request|workflow_dispatch|schedule:/);
  });

  it('runs CI and publication on our own runner, never on one GitHub bills for (ADR 0020)', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    for (const file of [ci, workflow]) {
      expect(/runs-on: (.*)$/m.exec(file)?.[1]).toBe('[self-hosted, linux, x64, hamnivo]');
    }
    expect(workflow).not.toContain('vars.');
  });

  it('uses the same actions as ci.yml, each pinned to a commit', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    // A tag can be moved to other code; a commit cannot. Each pin names its release in a comment.
    const pins = (file: string) =>
      new Map(
        [...file.matchAll(/uses: ([\w./-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/gm)].map((match) => [
          match[1],
          `${match[2]} ${match[3]}`,
        ]),
      );
    for (const file of [ci, workflow]) {
      expect(file).not.toMatch(/uses: [\w./-]+@(?![0-9a-f]{40} # v)/);
    }
    for (const action of ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node']) {
      expect(pins(workflow).get(action), action).toBeDefined();
      expect(pins(workflow).get(action), action).toBe(pins(ci).get(action));
    }
  });

  it('can read nothing but the repository, and reaches the token only in the two steps that need it', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    const uses = workflow.split('\n').filter((line) => line.includes('secrets.NPM_TOKEN'));
    expect(uses).toHaveLength(2);
    // The token is never written to the log, and the tag never goes into script text.
    expect(workflow).not.toMatch(/echo[^\n]*\$NPM_TOKEN|echo[^\n]*NODE_AUTH_TOKEN|set -x/);
    expect(workflow).not.toMatch(/run:[^\n]*\$\{\{ github\.ref_name/);
    for (const step of ['Work out which package the tag is for', 'Publish to npm']) {
      expect(script(step), step).not.toContain('${{');
    }
  });

  it('checks the token first, then runs the package checks before it publishes', () => {
    const order = [
      'Work out which package the tag is for',
      'Check the npm token is there',
      'Install dependencies',
      'Lint, type-check and test the package',
      'Publish to npm',
    ].map((step) => workflow.indexOf(`- name: ${step}`));
    expect(order.every((position) => position > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('publishes publicly, to npm, once, and says so when the version is already there', () => {
    const publish = script('Publish to npm');
    expect(publish).toContain(
      'pnpm --filter "$FILTER" publish --access public --tag "$NPM_TAG" --no-git-checks',
    );
    expect(publish).toContain('npm view "$FILTER@$VERSION" version');
    expect(workflow).toContain('registry-url: https://registry.npmjs.org');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('refuses to publish a missing token, with words that say what to do', () => {
    const result = spawnSync('bash', ['-c', script('Check the npm token is there')], {
      env: { PATH: process.env.PATH ?? '', NPM_TOKEN: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Add it under Settings, Secrets and variables, Actions');
    const present = spawnSync('bash', ['-c', script('Check the npm token is there')], {
      env: { PATH: process.env.PATH ?? '', NPM_TOKEN: 'not-a-real-token' },
      encoding: 'utf8',
    });
    expect(present.status).toBe(0);
    expect(present.stdout + present.stderr).not.toContain('not-a-real-token');
  });
});
