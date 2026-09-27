import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  classifyStatus,
  importContactIdentifier,
  importConversationKey,
  importMessageKey,
  isImportKey,
  keyPart,
  MAX_ITEM_ATTEMPTS,
  nextStep,
  Pacer,
} from '../src/index.js';

const JOB = 'mig_01j9zk7w3xq8r4t2v6m5n1p0cd';

describe('import keys', () => {
  it('writes messages with hv1:imp:<job>:<source id>, stable across re-runs', () => {
    const key = importMessageKey(JOB, '1f0c6f40-9b3e-11ef-8d6a-2b7c9e4f5a10:3');
    expect(key).toBe(`hv1:imp:${JOB}:1f0c6f40-9b3e-11ef-8d6a-2b7c9e4f5a10:3`);
    expect(importMessageKey(JOB, '1f0c6f40-9b3e-11ef-8d6a-2b7c9e4f5a10:3')).toBe(key);
    expect(isImportKey(key)).toBe(true);
    expect(isImportKey('hv1:m:123')).toBe(false);
  });

  it('hashes long or unusual source IDs, so keys stay short and safe', () => {
    const long = 'x'.repeat(300);
    expect(keyPart(long)).toMatch(/^h\.[A-Za-z0-9_-]{32}$/);
    expect(keyPart('a b')).not.toContain(' ');
    expect(keyPart('someone@example.com')).not.toContain('@');
    expect(importConversationKey(JOB, 'conv 1')).toMatch(/^hv1:imp:mig_[0-9a-z]+:c:h\./);
  });

  it('never puts a contact source ID in the Chatwoot identifier (it may be an email)', () => {
    const identifier = importContactIdentifier(JOB, 'visitor:someone@example.com');
    expect(identifier).toMatch(new RegExp(`^hv:imp:${JOB}:[A-Za-z0-9_-]{32}$`));
    expect(identifier).not.toContain('example');
    expect(importContactIdentifier('mig_other', 'visitor:someone@example.com')).not.toBe(
      identifier,
    );
  });
});

describe('checkpoints and bounded retries', () => {
  it('sends pending writes, looks up writes that may have happened, and gives up in time', () => {
    expect(nextStep({ status: 'pending', attempts: 0 })).toBe('write');
    expect(nextStep({ status: 'writing', attempts: 1 })).toBe('resolve');
    expect(nextStep({ status: 'writing', attempts: MAX_ITEM_ATTEMPTS })).toBe('give_up');
    expect(nextStep({ status: 'pending', attempts: MAX_ITEM_ATTEMPTS })).toBe('give_up');
    for (const status of ['imported', 'skipped', 'quarantined', 'failed', 'rolled_back'] as const) {
      expect(nextStep({ status, attempts: 0 })).toBe('done');
    }
  });

  it('treats timeouts and server errors as unknown outcomes, never as failures to resend blindly', () => {
    expect(classifyStatus(0)).toBe('unknown');
    expect(classifyStatus(504)).toBe('unknown');
    expect(classifyStatus(500)).toBe('unknown');
    expect(classifyStatus(429)).toBe('retry');
    expect(classifyStatus(422)).toBe('permanent');
    expect(classifyStatus(404)).toBe('permanent');
  });

  it('backs off exponentially with jitter, capped at five minutes', () => {
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(1, () => 0.999)).toBeLessThanOrEqual(1000);
    expect(backoffMs(4, () => 0)).toBe(4000);
    expect(backoffMs(30, () => 0.999)).toBeLessThanOrEqual(300_000);
  });
});

describe('pacing', () => {
  function clock() {
    let now = 1_000_000;
    const sleeps: number[] = [];
    return {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      advance: (ms: number) => {
        now += ms;
      },
      sleeps,
    };
  }

  it('keeps each conversation under the per-minute limit', async () => {
    const c = clock();
    const pacer = new Pacer(3, c.now, c.sleep);
    for (let i = 0; i < 3; i += 1) expect(await pacer.take()).toBe(0);
    c.advance(10_000);
    // The fourth write waits until the first one is a minute old.
    expect(await pacer.take()).toBe(50_000);
    expect(c.sleeps).toEqual([50_000]);
  });

  it('remembers writes from before a restart', async () => {
    const c = clock();
    const pacer = new Pacer(2, c.now, c.sleep);
    pacer.seed([c.now() - 30_000, c.now() - 20_000, c.now() - 90_000]);
    expect(await pacer.take()).toBe(30_000);
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => new Pacer(0)).toThrow(RangeError);
  });
});
