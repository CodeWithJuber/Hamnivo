import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The package as it will be published: the files that `tsdown` wrote to dist (the test script
 * builds first), and the package.json that points at them.
 */
const root = join(import.meta.dirname, '..');
const pack = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  exports: Record<string, { types: string; import: string }>;
  files: string[];
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional: boolean }>;
  dependencies?: Record<string, string>;
  publishConfig: { access: string };
  license: string;
};
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const importsOf = (code: string) =>
  [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);

describe('the published package', () => {
  it('is @hamnivo/react, public, MIT, with nothing it needs besides React and, for the hooks, the client', () => {
    expect(pack.name).toBe('@hamnivo/react');
    expect(pack.publishConfig.access).toBe('public');
    expect(pack.license).toBe('MIT');
    expect(pack.files).toEqual(['dist']);
    expect(pack.dependencies).toBeUndefined();
    expect(pack.peerDependencies.react).toMatch(/^>=18/);
    expect(pack.peerDependenciesMeta['@hamnivo/client']).toEqual({ optional: true });
    // Linked from the workspace, never fetched: the client is not on npm yet, and the gateway
    // image's `pnpm deploy` resolves every workspace package. Publishing writes ">=0.1.0".
    expect(pack.peerDependencies['@hamnivo/client']).toBe('workspace:>=0.1.0');
    expect(existsSync(join(root, 'LICENSE'))).toBe(true);
    expect(read('LICENSE')).toBe(readFileSync(join(root, '../../LICENSE'), 'utf8'));
  });

  it('points each entry at files that were built, with types', () => {
    expect(Object.keys(pack.exports)).toEqual(['.', './client']);
    for (const [name, entry] of Object.entries(pack.exports)) {
      expect(existsSync(join(root, entry.import)), `${name} import`).toBe(true);
      expect(existsSync(join(root, entry.types)), `${name} types`).toBe(true);
    }
  });

  it('starts every entry with "use client", so a Next.js server component can import it', () => {
    for (const file of ['dist/index.js', 'dist/client.js']) {
      expect(read(file).startsWith('"use client";\n'), file).toBe(true);
    }
  });

  it('keeps the chat and its React out of the headless hooks, and the client out of the chat', () => {
    expect(importsOf(read('dist/index.js'))).toEqual(['react']);
    expect(importsOf(read('dist/client.js')).sort()).toEqual(['@hamnivo/client', 'react']);
    expect(read('dist/client.js')).not.toContain('Hamnivo Chat is not on this page');
  });

  it('exports what the README names', () => {
    const index = read('dist/index.d.ts');
    for (const name of [
      'HamnivoChat',
      'useHamnivo',
      'loadHamnivo',
      'HamnivoChatProps',
      'HamnivoCustomer',
      'HamnivoState',
    ]) {
      expect(index, name).toContain(name);
    }
    const client = read('dist/client.d.ts');
    for (const name of ['useHamnivoClient', 'useOutbox', 'useConversationStream']) {
      expect(client, name).toContain(name);
    }
  });
});
