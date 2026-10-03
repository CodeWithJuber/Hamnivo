import type { DeviceType } from '@hamnivo/contracts';
import Bowser from 'bowser';

/** What is kept about a visitor's device: names and the main version, nothing that tells browsers apart. */
export interface DeviceInfo {
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  deviceType: DeviceType;
}

/** A User-Agent longer than this is cut before it is read (they are under 300 characters in practice). */
const MAX_USER_AGENT = 512;
const MAX_NAME = 40;

/** Search engines, link previews and monitors are not visitors: nobody is there to help. */
const AUTOMATED =
  /bot\b|crawl|spider|slurp|headless|lighthouse|pagespeed|facebookexternalhit|preview|monitor|uptime|curl\/|wget\/|python-requests|go-http-client/i;

export const isAutomated = (userAgent: string | undefined): boolean =>
  userAgent === undefined || userAgent.trim() === '' || AUTOMATED.test(userAgent);

const name = (value: string | undefined): string | null => {
  const trimmed = value?.trim().slice(0, MAX_NAME);
  return trimmed ? trimmed : null;
};

/** The first number of a version: "120.0.6099.109" is kept as "120", "NT 10.0" as "10". */
const major = (version: string | undefined): string | null => {
  const found = version?.match(/\d{1,6}/)?.[0];
  return found ?? null;
};

const UNKNOWN: DeviceInfo = {
  browser: null,
  browserVersion: null,
  os: null,
  osVersion: null,
  deviceType: 'other',
};

/** The browser, system and kind of device from the User-Agent header (read with `bowser`). */
export function readDevice(userAgent: string | undefined): DeviceInfo {
  const agent = (userAgent ?? '').slice(0, MAX_USER_AGENT).trim();
  if (agent === '') return UNKNOWN;
  try {
    const parsed = Bowser.parse(agent);
    const kind = parsed.platform.type;
    return {
      browser: name(parsed.browser.name),
      browserVersion: major(parsed.browser.version),
      os: name(parsed.os.name),
      // Windows says "NT 10.0"; its name for the release ("10") is the better one to keep.
      osVersion: major(parsed.os.versionName) ?? major(parsed.os.version),
      deviceType: kind === 'desktop' || kind === 'mobile' || kind === 'tablet' ? kind : 'other',
    };
  } catch {
    return UNKNOWN;
  }
}
