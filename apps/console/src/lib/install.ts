import { GATEWAY_ORIGIN, WIDGET_ORIGIN } from './config';

/**
 * The loader tag for a brand (packages/widget-loader). The widget ID is not a secret: it is in
 * every page the chat is on.
 */
export function installSnippet(widgetId: string): string {
  return `<script src="${WIDGET_ORIGIN}/loader.js" data-widget-id="${widgetId}" data-api="${GATEWAY_ORIGIN}" async></script>`;
}

/**
 * Where a business may be putting the chat. Each platform has its own written guide in
 * `docs/guide/integrations/<slug>.md`; the picker in the setup guide links to the one chosen.
 * The list lives here and nowhere else: a guide that is added or renamed is changed in this file,
 * and `test/install.test.ts` checks every slug against the guides on disk.
 */
export const PLATFORMS = [
  { id: 'html', slug: 'html' },
  { id: 'wordpress', slug: 'wordpress' },
  // The WordPress plugin covers WooCommerce shops and their signed-in customers.
  { id: 'woocommerce', slug: 'wordpress' },
  { id: 'shopify', slug: 'shopify' },
  { id: 'whmcs', slug: 'whmcs' },
  // Site builders take the plain HTML snippet; the HTML guide says where each one keeps it.
  { id: 'wix', slug: 'html' },
  { id: 'squarespace', slug: 'html' },
  { id: 'webflow', slug: 'html' },
  { id: 'google-tag-manager', slug: 'gtm' },
  { id: 'react', slug: 'react-vue-next' },
  { id: 'vue', slug: 'react-vue-next' },
  { id: 'nextjs', slug: 'react-vue-next' },
] as const;

export type PlatformId = (typeof PLATFORMS)[number]['id'];

export const isPlatform = (value: string): value is PlatformId =>
  PLATFORMS.some((platform) => platform.id === value);

/** The guide for a platform, by file name without `.md`. */
export const guideSlug = (id: PlatformId): string =>
  PLATFORMS.find((platform) => platform.id === id)?.slug ?? id;
