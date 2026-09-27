import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { HostBridge } from './bridge.js';
import { applyLocale, initI18n, pickLocale } from './i18n.js';
import './styles.css';

const query = new URLSearchParams(window.location.search);
const locale = pickLocale(query.get('locale') ?? navigator.language);
const params = {
  apiBase: query.get('api') ?? import.meta.env.VITE_HAMNIVO_API ?? 'http://localhost:4000',
  widgetId: query.get('widgetId') ?? '',
  hostOrigin: query.get('host'),
  locale,
};
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
