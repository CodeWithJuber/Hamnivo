import { describe, expect, it } from 'vitest';
import { consentRequired, plausibleEmail, plausiblePhone } from '../src/index.js';

describe('consent before chatting (W27)', () => {
  it('asks nobody when off and everybody when on for everyone', () => {
    expect(consentRequired('off', 'DE')).toBe(false);
    expect(consentRequired('off', null)).toBe(false);
    expect(consentRequired('everyone', 'AE')).toBe(true);
    expect(consentRequired('everyone', null)).toBe(true);
  });

  it('asks visitors from the EU, the EEA and the UK, and those whose country is unknown', () => {
    for (const country of ['DE', 'fr', 'IE', 'NO', 'IS', 'LI', 'GB']) {
      expect(consentRequired('eu', country), country).toBe(true);
    }
    expect(consentRequired('eu', null)).toBe(true);
    for (const country of ['AE', 'IN', 'PK', 'US', 'CH', 'SA']) {
      expect(consentRequired('eu', country), country).toBe(false);
    }
  });
});

describe('form answers (W26, W11)', () => {
  it('accepts plausible addresses and refuses the rest', () => {
    expect(plausibleEmail('aisha@example.com')).toBe(true);
    expect(plausibleEmail('a.b+c@sub.example.co.uk')).toBe(true);
    for (const bad of ['aisha', 'aisha@', '@example.com', 'a b@example.com', 'a@b']) {
      expect(plausibleEmail(bad), bad).toBe(false);
    }
    expect(plausibleEmail(`${'a'.repeat(250)}@x.io`)).toBe(false);
  });

  it('accepts phone numbers written the usual ways and refuses words', () => {
    for (const ok of ['+971 4 123 4567', '(022) 555-0100', '0300.1234567', '1234']) {
      expect(plausiblePhone(ok), ok).toBe(true);
    }
    for (const bad of ['call me', '12', '+971-abc', `+${'1'.repeat(25)}`]) {
      expect(plausiblePhone(bad), bad).toBe(false);
    }
  });
});
