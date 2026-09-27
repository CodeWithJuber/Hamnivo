import type { ProductVisual } from '@hamnivo/brand';

/**
 * What each feature point can promise. `today` means working code with tests in the repository;
 * `coming` means planned or not yet usable. Each point cites its IDs in docs/feature-status.md,
 * so update the status here when that file changes.
 */
export type PointStatus = 'today' | 'coming';

export const features = {
  teamwork: {
    visual: 'teamwork',
    // W10 + R12 handoff, H08 + R06 takeover fencing, W04 responder identity,
    // G02 model providers (only the offline test model exists), H01 + R02 staff workspace.
    points: ['today', 'today', 'today', 'coming', 'coming'],
  },
  memory: {
    visual: 'memory',
    // L01-L08 and G19 are all planned.
    points: ['coming', 'coming', 'coming'],
  },
  developers: {
    visual: 'integrations',
    // W01 loader, D01 REST + OpenAPI, D02 client SDK, W07 resumable stream, D06 webhooks.
    points: ['today', 'today', 'today', 'today', 'coming'],
  },
  languages: {
    visual: 'multilingual',
    // W13 locales, U04 right to left, U02 Hinglish and Roman Urdu, U03 translations.
    points: ['today', 'today', 'coming', 'coming'],
  },
  commerce: {
    visual: 'commerce',
    // C01-C20 are all planned.
    points: ['coming', 'coming', 'coming', 'coming'],
  },
} as const satisfies Record<
  string,
  { visual: ProductVisual['id']; points: readonly PointStatus[] }
>;

export type FeatureId = keyof typeof features;
export const featureIds = Object.keys(features) as FeatureId[];

/** A section is labelled "Coming" as a whole when none of its points works yet. */
export function isComingSoon(id: FeatureId): boolean {
  return features[id].points.every((status) => status === 'coming');
}
