import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The package as it will be published: the files that `tsdown` wrote to dist (the test script
 * builds first), the package.json that points at them, and the file it shares with @hamnivo/react.
 */
const root = join(import.meta.dirname, '..');
const pack = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, { types: string; import: string }>;
  files: string[];
  peerDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
  publishConfig: { access: string };
  license: string;
};
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const importsOf = (code: string) =>
  [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);

describe('the published package', () => {
  it('is @hamnivo/vue, public, MIT, and needs nothing but Vue', () => {
    expect(pack.name).toBe('@hamnivo/vue');
    expect(pack.publishConfig.access).toBe('public');
    expect(pack.license).toBe('MIT');
    expect(pack.files).toEqual(['dist']);
    expect(pack.dependencies).toBeUndefined();
    expect(pack.peerDependencies).toEqual({ vue: '>=3.3.0' });
    expect(read('LICENSE')).toBe(readFileSync(join(root, '../../LICENSE'), 'utf8'));
  });

  it('points its one entry at files that were built, with types', () => {
    expect(Object.keys(pack.exports)).toEqual(['.']);
    expect(existsSync(join(root, pack.exports['.']?.import ?? 'missing'))).toBe(true);
    expect(existsSync(join(root, pack.exports['.']?.types ?? 'missing'))).toBe(true);
  });

  it('imports only Vue', () => {
    expect(importsOf(read('dist/index.js'))).toEqual(['vue']);
  });

  it('exports what the README names', () => {
    const index = read('dist/index.d.ts');
    for (const name of [
      'HamnivoChat',
      'createHamnivo',
      'useHamnivo',
      'loadHamnivo',
      'HamnivoPluginOptions',
      'HamnivoCustomer',
    ]) {
      expect(index, name).toContain(name);
    }
  });
});

describe('the code shared with @hamnivo/react', () => {
  it('is the same file in both, so a fix to one is a fix to both', () => {
    const react = readFileSync(join(root, '../react/src/embed.ts'), 'utf8');
    expect(read('src/embed.ts')).toBe(react);
  });
});
