import { describe, expect, it } from 'vitest';
import { SightingThrottle, sightedOrigin } from '../src/widget/install-sightings.js';

describe('which page counts as the chat being installed (HNV-01-04)', () => {
  const allowed = ['https://shop.example', 'https://blog.example:8443'];

  it('is a page on exactly one of the brand’s websites', () => {
    expect(sightedOrigin(allowed, 'https://shop.example')).toBe('https://shop.example');
    expect(sightedOrigin(allowed, 'https://blog.example:8443')).toBe('https://blog.example:8443');
    expect(sightedOrigin(allowed, 'https://SHOP.example')).toBe('https://shop.example');
  });

  it('is never another website, a local page, Studio or a page that did not say', () => {
    expect(sightedOrigin(allowed, 'https://evil.example')).toBeUndefined();
    expect(sightedOrigin(allowed, 'http://shop.example')).toBeUndefined();
    expect(sightedOrigin(allowed, 'https://shop.example.evil.example')).toBeUndefined();
    expect(sightedOrigin([], 'http://localhost:5173')).toBeUndefined();
    expect(sightedOrigin(allowed, undefined)).toBeUndefined();
    expect(sightedOrigin(allowed, 'not a url')).toBeUndefined();
  });
});

describe('how often a sighting is written', () => {
  it('once per brand and website every interval', () => {
    const throttle = new SightingThrottle(60_000);
    expect(throttle.due('brand-a', 'https://shop.example', 0)).toBe(true);
    expect(throttle.due('brand-a', 'https://shop.example', 59_999)).toBe(false);
    // Another website or brand is its own.
    expect(throttle.due('brand-a', 'https://blog.example', 1)).toBe(true);
    expect(throttle.due('brand-b', 'https://shop.example', 1)).toBe(true);
    expect(throttle.due('brand-a', 'https://shop.example', 60_000)).toBe(true);
  });

  it('tries again at once after a failed write', () => {
    const throttle = new SightingThrottle(60_000);
    expect(throttle.due('brand-a', 'https://shop.example', 0)).toBe(true);
    throttle.forget('brand-a', 'https://shop.example');
    expect(throttle.due('brand-a', 'https://shop.example', 1)).toBe(true);
  });
});
