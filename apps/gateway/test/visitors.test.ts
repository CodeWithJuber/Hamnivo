import { describe, expect, it } from 'vitest';
import { isAutomated, readDevice } from '../src/visitors/device.js';
import {
  cleanLanguage,
  cleanReferrer,
  cleanTitle,
  cleanUrl,
  countryOf,
  privacyOptOut,
} from '../src/visitors/privacy.js';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';

describe('device and browser from the User-Agent', () => {
  it('names the browser, the system and the kind of device', () => {
    expect(readDevice(CHROME_WINDOWS)).toEqual({
      browser: 'Chrome',
      browserVersion: '120',
      os: 'Windows',
      osVersion: '10',
      deviceType: 'desktop',
    });
    expect(readDevice(IPHONE)).toMatchObject({
      browser: 'Safari',
      browserVersion: '17',
      os: 'iOS',
      deviceType: 'mobile',
    });
    expect(readDevice(IPAD)).toMatchObject({ browser: 'Safari', os: 'iOS', deviceType: 'tablet' });
    expect(readDevice(ANDROID)).toMatchObject({
      browser: 'Chrome',
      os: 'Android',
      osVersion: '14',
      deviceType: 'mobile',
    });
    expect(readDevice(FIREFOX_LINUX)).toMatchObject({
      browser: 'Firefox',
      browserVersion: '121',
      os: 'Linux',
      deviceType: 'desktop',
    });
  });

  it('keeps only the main version, so versions do not tell browsers apart', () => {
    const device = readDevice(CHROME_WINDOWS);
    expect(device.browserVersion).toBe('120');
    expect(JSON.stringify(device)).not.toContain('6099');
  });

  it('says "other" and keeps no names for something it does not know', () => {
    expect(readDevice('something/1.0')).toEqual({
      browser: null,
      browserVersion: null,
      os: null,
      osVersion: null,
      deviceType: 'other',
    });
    expect(readDevice(undefined).deviceType).toBe('other');
  });

  it('reads at most the first part of a very long header', () => {
    const long = `${CHROME_WINDOWS} ${'x'.repeat(100_000)}`;
    expect(readDevice(long).browser).toBe('Chrome');
  });

  it('leaves out search engines, previews and scripts: nobody is there to help', () => {
    expect(isAutomated(CHROME_WINDOWS)).toBe(false);
    expect(isAutomated(IPHONE)).toBe(false);
    expect(isAutomated(ANDROID)).toBe(false);
    for (const agent of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'curl/8.4.0',
      'python-requests/2.31.0',
      '',
      undefined,
    ]) {
      expect(isAutomated(agent), String(agent)).toBe(true);
    }
  });
});

describe('page addresses', () => {
  it('removes the query string by default, and the fragment, user name and password always', () => {
    expect(
      cleanUrl('https://shop.example/pricing?email=maya@example.com&utm=1#plans', false),
    ).toEqual({ url: 'https://shop.example/pricing', origin: 'https://shop.example' });
    expect(cleanUrl('https://user:secret@shop.example/a/b/?x=1', false)?.url).toBe(
      'https://shop.example/a/b/',
    );
    expect(cleanUrl('https://shop.example', false)?.url).toBe('https://shop.example/');
  });

  it('keeps the query string when the brand chose to, without values that look like secrets', () => {
    const kept = cleanUrl(
      'https://shop.example/orders?page=2&token=abc123&reset_code=999&Session=zzz&q=shoes',
      true,
    );
    expect(kept?.url).toContain('page=2');
    expect(kept?.url).toContain('q=shoes');
    expect(kept?.url).not.toContain('abc123');
    expect(kept?.url).not.toContain('999');
    expect(kept?.url).not.toContain('zzz');
    expect(kept?.url).toContain('token=%5Bremoved%5D');
  });

  it('only takes web addresses of a sensible length', () => {
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'nope',
      '',
    ]) {
      expect(cleanUrl(bad, false), bad).toBeNull();
    }
    expect(cleanUrl(`https://shop.example/${'a'.repeat(1200)}`, false)).toBeNull();
  });

  it('cuts a referrer down to its address, and a title to one short line', () => {
    expect(cleanReferrer('https://www.google.com/search?q=hamnivo+shop&hl=en#top')).toBe(
      'https://www.google.com/search',
    );
    expect(cleanReferrer('')).toBeNull();
    expect(cleanReferrer(undefined)).toBeNull();
    expect(cleanReferrer('not a url')).toBeNull();
    expect(cleanTitle('  Pricing \n\t· Noor   Books\u0007 ')).toBe('Pricing · Noor Books');
    expect(cleanTitle('x'.repeat(500))).toHaveLength(200);
    expect(cleanTitle('   ')).toBeNull();
  });
});

describe('what the browser says about privacy and place', () => {
  it('treats Do Not Track and Global Privacy Control as a reason to keep nothing', () => {
    expect(privacyOptOut({ dnt: '1' })).toBe(true);
    expect(privacyOptOut({ 'sec-gpc': '1' })).toBe(true);
    expect(privacyOptOut({ dnt: '0' })).toBe(false);
    expect(privacyOptOut({ dnt: undefined, 'sec-gpc': undefined })).toBe(false);
    expect(privacyOptOut({})).toBe(false);
    expect(privacyOptOut({ dnt: ['1'] })).toBe(true);
  });

  it('takes the country from Cloudflare’s header, and says none when it is unknown', () => {
    expect(countryOf({ 'cf-ipcountry': 'PK' })).toBe('PK');
    expect(countryOf({ 'cf-ipcountry': 'pk' })).toBe('PK');
    expect(countryOf({ 'cf-ipcountry': 'XX' })).toBeNull();
    expect(countryOf({ 'cf-ipcountry': 'T1' })).toBeNull();
    expect(countryOf({ 'cf-ipcountry': 'Pakistan' })).toBeNull();
    expect(countryOf({})).toBeNull();
  });

  it('never reads an address header', () => {
    // The only headers the module reads are these; forwarded addresses are not among them.
    const read = [privacyOptOut, countryOf].map((fn) => fn.toString()).join('\n');
    expect(read).not.toMatch(/x-forwarded-for|x-real-ip|remote-?addr|cf-connecting-ip/i);
  });

  it('accepts a language tag and nothing else', () => {
    expect(cleanLanguage('en')).toBe('en');
    expect(cleanLanguage('ar-SA')).toBe('ar-SA');
    expect(cleanLanguage('zh-Hans-CN')).toBe('zh-Hans-CN');
    expect(cleanLanguage('<script>')).toBeNull();
    expect(cleanLanguage('')).toBeNull();
    expect(cleanLanguage(undefined)).toBeNull();
  });
});
