import { describe, expect, it } from 'vitest';
import { countryName, deviceLine, formatSpan, pathOf } from '../src/lib/visitors';

describe('how long a visitor has been on the site', () => {
  it('says minutes and hours, and nothing for less than a minute', () => {
    expect(formatSpan(0, 'en')).toBeNull();
    expect(formatSpan(59, 'en')).toBeNull();
    expect(formatSpan(-20, 'en')).toBeNull();
    expect(formatSpan(60, 'en')).toBe('1 min');
    expect(formatSpan(5 * 60 + 40, 'en')).toBe('5 min');
    expect(formatSpan(60 * 60, 'en')).toBe('1 hr');
    expect(formatSpan(65 * 60, 'en')).toBe('1 hr 5 min');
    expect(formatSpan(26 * 3600 + 120, 'en')).toBe('26 hr 2 min');
  });
});

describe('a visitor’s place and page', () => {
  it('names the country in the interface language, or keeps the code it cannot name', () => {
    expect(countryName('PK', 'en')).toBe('Pakistan');
    expect(countryName('AE', 'en')).toBe('United Arab Emirates');
    expect(countryName('PK', 'ar')).toBe('باكستان');
    expect(countryName(null, 'en')).toBeNull();
    expect(countryName('ZZ', 'en')).toBe('Unknown Region');
  });

  it('shows the part of a page address after the website', () => {
    expect(pathOf('https://shop.example/pricing/teams')).toBe('/pricing/teams');
    expect(pathOf('https://shop.example/')).toBe('/');
    expect(pathOf('https://shop.example')).toBe('/');
    expect(pathOf('https://shop.example/search?q=shoes')).toBe('/search?q=shoes');
    expect(pathOf('not a url')).toBe('not a url');
  });

  it('describes the device by kind, browser and system, leaving out what is not known', () => {
    expect(deviceLine({ type: 'mobile', browser: 'Safari 17', os: 'iOS 17' }, 'Phone')).toBe(
      'Phone · Safari 17 · iOS 17',
    );
    expect(deviceLine({ type: 'desktop', browser: null, os: 'Windows 10' }, 'Computer')).toBe(
      'Computer · Windows 10',
    );
    expect(deviceLine({ type: 'other', browser: null, os: null }, 'Device')).toBe('Device');
  });
});
