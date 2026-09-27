interface ImportMetaEnv {
  /** Canonical origin (read in astro.config.ts). */
  readonly PUBLIC_SITE_URL?: string;
  /** Live demo: all three must be set, or the page shows the install snippet instead. */
  readonly PUBLIC_HAMNIVO_WIDGET_ID?: string;
  readonly PUBLIC_HAMNIVO_WIDGET_ORIGIN?: string;
  readonly PUBLIC_HAMNIVO_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  Hamnivo?: { open(): void };
}
