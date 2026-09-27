import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { brandRootFiles, brandVisualsDir } from './integrations/brand';

/** Canonical origin. The site is served from the root of this origin. */
function siteUrl(value = process.env.PUBLIC_SITE_URL): string {
  if (!value) return 'https://hamnivo.example';
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || !/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      `PUBLIC_SITE_URL must be an origin such as https://hamnivo.example, got "${value}"`,
    );
  }
  return url.origin;
}

export default defineConfig({
  site: siteUrl(),
  output: 'static',
  // Keep whitespace between inline elements, as translated copy is written as plain sentences.
  compressHTML: true,
  // The CSS is small; inlining it removes a render-blocking request.
  build: { inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
  integrations: [
    brandRootFiles(),
    sitemap({
      i18n: { defaultLocale: 'en', locales: { en: 'en', ar: 'ar', hi: 'hi', ur: 'ur' } },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    // Lets import.meta.glob pick up the brand's responsive visuals, so they get hashed file names.
    resolve: { alias: { '@brand-visuals': brandVisualsDir } },
  },
});
