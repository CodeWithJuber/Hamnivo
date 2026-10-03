/**
 * Where a business may be putting the chat. Each platform has its own written guide in
 * `docs/guide/integrations/<slug>.md`; the picker in the setup guide links to the one chosen.
 * The list lives here and nowhere else: a guide that is added or renamed is changed in this file,
 * and `test/install.test.ts` checks every slug against the guides on disk.
 */
export const PLATFORMS = [
  { id: 'html', slug: 'html' },
  { id: 'wordpress', slug: 'wordpress' },
  { id: 'woocommerce', slug: 'woocommerce' },
  { id: 'shopify', slug: 'shopify' },
  { id: 'wix', slug: 'wix' },
  { id: 'squarespace', slug: 'squarespace' },
  { id: 'webflow', slug: 'webflow' },
  { id: 'google-tag-manager', slug: 'google-tag-manager' },
  { id: 'react', slug: 'react' },
  { id: 'nextjs', slug: 'nextjs' },
] as const;

export type PlatformId = (typeof PLATFORMS)[number]['id'];

export const isPlatform = (value: string): value is PlatformId =>
  PLATFORMS.some((platform) => platform.id === value);

/** The guide for a platform, by file name without `.md`. */
export const guideSlug = (id: PlatformId): string =>
  PLATFORMS.find((platform) => platform.id === id)?.slug ?? id;
