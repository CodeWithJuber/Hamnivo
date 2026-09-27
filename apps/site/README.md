# Hamnivo website (`apps/site`)

The public website, in English, Arabic, Hindi and Urdu. It is a static Astro site styled with
Tailwind and the tokens, fonts and product visuals from `@hamnivo/brand`.

Pages ship no framework code. One small optional script adds copy buttons to code blocks and,
when the live demo is on, an "Open the chat" button. Everything works without it.

## Develop

```bash
pnpm install
pnpm --filter @hamnivo/brand build   # visuals and icons; again after brand changes
pnpm --filter @hamnivo/site dev      # http://localhost:5190
```

## Build and preview

```bash
pnpm --filter @hamnivo/site build    # astro check, then static files in apps/site/dist
pnpm --filter @hamnivo/site preview  # serves dist on http://localhost:5190
```

When an AI coding agent runs `astro preview`, Astro starts it in the background. Stop it with
`pnpm --filter @hamnivo/site exec astro preview stop`.

## Test

```bash
pnpm --filter @hamnivo/site build
pnpm --filter @hamnivo/site test:e2e
```

- Playwright serves `dist` with `astro preview` on port 5190.
- It uses the Chromium at `/opt/pw-browsers/chromium` when present, or
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.
- For every language, the tests check:
  - an axe audit for WCAG 2.2 AA at 1280 and 320 px wide;
  - `lang` and `dir`;
  - alt text on every image;
  - no sideways scrolling at 320 px, and no layout shift;
  - the language links, canonical and hreflang tags, icons and social image.
- They also check the sitemap, `robots.txt` and the copy button.

To save review screenshots of the English and Arabic pages in `e2e/screenshots/`:

```bash
SITE_SCREENSHOTS=1 pnpm --filter @hamnivo/site test:e2e -g "review screenshots"
```

## Environment variables

They are read at build time. The site builds without any of them. Set them in the environment
of the build command, for example
`PUBLIC_SITE_URL=https://www.example.org pnpm --filter @hamnivo/site build`.

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_SITE_URL` | `https://hamnivo.example` | The origin used in canonical links, hreflang, Open Graph, `robots.txt` and the sitemap. An origin only, with no path. |
| `PUBLIC_HAMNIVO_WIDGET_ID` | none | Live demo: the brand's widget ID (`wid_…`). |
| `PUBLIC_HAMNIVO_WIDGET_ORIGIN` | none | Live demo: the origin that serves the widget and `loader.js`. |
| `PUBLIC_HAMNIVO_API` | none | Live demo: the gateway URL. |

- With all three widget variables set, every page loads the chat loader in its own language.
  Add the site's origin to the brand's allowed websites, or the gateway refuses the chat.
- With none of them, the demo section shows the install snippet instead.
- With only some, the build prints a warning and shows the snippet.

## Deploy

The build is plain files in `apps/site/dist`. Serve that folder from any web server or CDN.

- Serve `index.html` for folder paths, so `/ar/` returns `/ar/index.html`. Most servers do this
  already.
- Files in `/_astro/` have a content hash in their names. Cache them for a year
  (`Cache-Control: public, max-age=31536000, immutable`). Cache the HTML for a short time.
- The site must sit at the root of its origin. Set `PUBLIC_SITE_URL` to that origin before you
  build.
- Each page inlines its CSS and one small module script. A Content Security Policy must allow
  them, for example with `'unsafe-inline'` or hashes. With the live demo on, also allow the
  widget origin in `script-src` and `frame-src`.

For example, with Caddy:

```
www.example.org {
    root * /srv/hamnivo-site
    file_server
    header /_astro/* Cache-Control "public, max-age=31536000, immutable"
}
```

## Content and translations

- Each language has one typed dictionary in `src/i18n/`. English is the source.
- The Arabic, Hindi and Urdu text has not been reviewed by native speakers yet. Each file says
  so, and translated pages show a note in the footer.
- The image alt text comes from `@hamnivo/brand` and is also waiting for native review.
- `src/content/features.ts` decides which points say "Coming". Each entry cites its IDs in
  `docs/feature-status.md`. Update it when a feature ships.
- Commands and code stay in English on every page and always read left to right.
