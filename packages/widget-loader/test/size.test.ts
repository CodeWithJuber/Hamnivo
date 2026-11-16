import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

describe('loader bundle', () => {
  it('stays within the size budget (≤ 10 KB gzip target, 15 KB hard limit)', () => {
    const code = readFileSync(new URL('../dist/loader.js', import.meta.url));
    const gzip = gzipSync(code).length;
    expect(gzip).toBeLessThan(10 * 1024);
    expect(code.toString()).not.toMatch(/\bimport\b|\brequire\(/);
  });
});
