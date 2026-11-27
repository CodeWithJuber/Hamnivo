import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('runs CI and publication on GitHub-hosted runners, never on a self-hosted one (ADR 0021)', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    for (const file of [ci, workflow]) {
      const runners = [...file.matchAll(/runs-on: (.*)$/gm)].map((match) => match[1]);
      expect(runners.length).toBeGreaterThan(0);
      for (const runner of runners) expect(runner).toBe('ubuntu-24.04');
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

  it('can read nothing but the repository, and holds no npm token', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    // Trusted publishing: npm trusts this workflow's OIDC token, so it reads no secret at all.
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|set -x/);
    // The tag never goes into script text.
    expect(workflow).not.toMatch(/run:[^\n]*\$\{\{ github\.ref_name/);
    for (const step of ['Work out which package the tag is for', 'Publish to npm']) {
      expect(script(step), step).not.toContain('${{');
    }
  });

  it('publishes with trusted publishing, from the npm environment, with provenance (ADR 0021)', () => {
    expect(workflow).toMatch(/^ {4}environment: npm\n/m);
    expect(workflow).toMatch(
      /^ {4}permissions:\n {6}contents: read\n(?: {6}#[^\n]*\n)* {6}id-token: write\n/m,
    );
    // Only the job that publishes may ask for an OIDC token.
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
  });

  it('checks npm first, then runs the package checks before it publishes', () => {
    const order = [
      'Work out which package the tag is for',
      'Check that npm can publish with trusted publishing',
      'Install dependencies',
      'Lint, type-check and test the package',
      'Publish to npm',
    ].map((step) => workflow.indexOf(`- name: ${step}`));
    expect(order.every((position) => position > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('publishes publicly, to npm, once, and says so when the version is already there', () => {
    const publish = script('Publish to npm');
    // pnpm packs, so the workspace: ranges become versions; npm publishes the file.
    expect(publish).toContain('pnpm --filter "$FILTER" pack --pack-destination "$folder"');
    expect(publish).toContain(
      'npm publish "$tarball" --provenance --access public --tag "$NPM_TAG"',
    );
    expect(publish).toContain('npm view "$FILTER@$VERSION" version');
    expect(workflow).toContain('registry-url: https://registry.npmjs.org');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('refuses an npm too old for trusted publishing, with words that say why', () => {
    const check = (version: string) => {
      const folder = mkdtempSync(join(tmpdir(), 'hamnivo-npm-'));
      writeFileSync(join(folder, 'npm'), `#!/bin/sh\necho ${version}\n`);
      chmodSync(join(folder, 'npm'), 0o755);
      return spawnSync(
        'bash',
        ['-c', script('Check that npm can publish with trusted publishing')],
        {
          env: { PATH: `${folder}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        },
      );
    };
    for (const version of ['10.9.2', '11.4.2', '11.5.0']) {
      const result = check(version);
      expect(result.status, version).toBe(1);
      expect(result.stdout, version).toContain('needs npm 11.5.1 or later');
    }
    for (const version of ['11.5.1', '11.19.1', '12.0.0']) {
      expect(check(version).status, version).toBe(0);
    }
  });
});
