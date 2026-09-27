/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Gateway origin the browser calls. Empty: this origin (a proxy passes /v1 and /api/auth on). */
  readonly VITE_HAMNIVO_API?: string;
  /** Gateway origin written into the install snippet (defaults to VITE_HAMNIVO_API). */
  readonly VITE_HAMNIVO_GATEWAY_ORIGIN?: string;
  /** Origin that serves the widget and loader.js, for the install snippet. */
  readonly VITE_HAMNIVO_WIDGET_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
