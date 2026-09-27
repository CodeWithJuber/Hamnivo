/** Widget IDs are TypeIDs with the `wid` prefix (see packages/contracts/src/ids.ts). */
const WIDGET_ID = /^wid_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export interface LiveDemo {
  widgetId: string;
  widgetOrigin: string;
  api: string;
  loaderSrc: string;
}

interface DemoEnv {
  widgetId?: string | undefined;
  widgetOrigin?: string | undefined;
  api?: string | undefined;
}

function httpUrl(value: string, name: string): URL {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || !/^https?:$/.test(url.protocol)) {
    throw new Error(`${name} must be an http(s) URL, got "${value}"`);
  }
  return url;
}

/**
 * The live widget needs all three build-time variables. With none of them the page shows the
 * install snippet instead; with only some, the build warns so a typo is not silently ignored.
 */
export function readLiveDemo(env: DemoEnv): LiveDemo | null {
  const widgetId = env.widgetId?.trim() ?? '';
  const origin = env.widgetOrigin?.trim() ?? '';
  const api = env.api?.trim() ?? '';
  const given = [widgetId, origin, api].filter(Boolean).length;
  if (given === 0) return null;
  if (given < 3) {
    console.warn(
      'Live demo off: set PUBLIC_HAMNIVO_WIDGET_ID, PUBLIC_HAMNIVO_WIDGET_ORIGIN and PUBLIC_HAMNIVO_API together.',
    );
    return null;
  }
  if (!WIDGET_ID.test(widgetId)) {
    throw new Error(`PUBLIC_HAMNIVO_WIDGET_ID must be a widget ID (wid_…), got "${widgetId}"`);
  }
  const widgetUrl = httpUrl(origin, 'PUBLIC_HAMNIVO_WIDGET_ORIGIN');
  if (widgetUrl.pathname !== '/' || widgetUrl.search || widgetUrl.hash) {
    throw new Error(`PUBLIC_HAMNIVO_WIDGET_ORIGIN must be an origin only, got "${origin}"`);
  }
  const apiUrl = httpUrl(api, 'PUBLIC_HAMNIVO_API');
  return {
    widgetId,
    widgetOrigin: widgetUrl.origin,
    api: apiUrl.href.replace(/\/$/, ''),
    // The loader is served next to the widget app (docs/self-hosting.md).
    loaderSrc: `${widgetUrl.origin}/loader.js`,
  };
}

export const liveDemo = readLiveDemo({
  widgetId: import.meta.env.PUBLIC_HAMNIVO_WIDGET_ID,
  widgetOrigin: import.meta.env.PUBLIC_HAMNIVO_WIDGET_ORIGIN,
  api: import.meta.env.PUBLIC_HAMNIVO_API,
});

/** The loader tag as a site owner would paste it, with example values when there is no demo. */
export function loaderSnippet(demo: LiveDemo | null): string {
  const src = demo?.loaderSrc ?? 'https://chat.example.com/loader.js';
  const id = demo?.widgetId ?? 'wid_…';
  const api = demo?.api ?? 'https://api.example.com';
  return [
    '<script',
    `  src="${src}"`,
    `  data-widget-id="${id}"`,
    `  data-api="${api}"`,
    '  async',
    '></script>',
  ].join('\n');
}
