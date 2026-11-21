import { WidgetLayoutMode } from '@hamnivo/contracts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type WidgetParams } from './App.js';
import { HostBridge } from './bridge.js';
import { directWidgetId, noIndex } from './direct.js';
import { watchErrors } from './error-reporting.js';
import { applyLocale, initI18n, pickLocale } from './i18n.js';
import { resolveScheme, schemeOf } from './theme.js';
import './styles.css';

const query = new URLSearchParams(window.location.search);
const locale = pickLocale(query.get('locale') ?? navigator.language);
const mode = WidgetLayoutMode.safeParse(query.get('mode'));
// The brand's direct chat link (W28): the whole page, its own session, no website to talk to.
const direct = directWidgetId(window.location.pathname);
if (direct) noIndex(document);
const params: WidgetParams = {
  // A production build pins its gateway; the loader's `api` parameter serves development builds.
  apiBase: import.meta.env.VITE_HAMNIVO_API ?? query.get('api') ?? 'http://localhost:4000',
  widgetId: direct ?? query.get('widgetId') ?? '',
  hostOrigin: direct ? null : query.get('host'),
  locale,
  mode: direct ? 'fullpage' : mode.success ? mode.data : null,
  // Studio's test chat: the owner trying their own widget (A01).
  test: !direct && query.get('test') === '1',
  direct: direct !== null,
  theme: schemeOf(query.get('theme')),
  caps: (query.get('caps') ?? '').split(',').filter(Boolean),
};
watchErrors(params.apiBase);
// Light or dark is decided before anything is drawn, so the chat never flashes the other one.
document.documentElement.dataset.theme = resolveScheme(
  'auto',
  params.theme ?? null,
  Boolean(params.hostOrigin),
  matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
);
applyLocale(locale);
await initI18n(locale);
const bridge = new HostBridge(params.hostOrigin, query.get('instance') ?? 'default');
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App params={params} bridge={bridge} />
    </StrictMode>,
  );
}
