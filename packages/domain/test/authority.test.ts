import { describe, expect, it } from 'vitest';
import { isHamnivoKey, MESSAGE_KEY_PREFIX } from '../src/index.js';

describe('message keys', () => {
  it('recognizes keys written by Hamnivo', () => {
    expect(isHamnivoKey(`${MESSAGE_KEY_PREFIX.message}0192`)).toBe(true);
    expect(isHamnivoKey('wamid.HBgM')).toBe(false);
    expect(isHamnivoKey(null)).toBe(false);
  });
});
