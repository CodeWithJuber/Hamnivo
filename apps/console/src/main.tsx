import favicon from '@hamnivo/brand/assets/favicon.svg?url';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyLocale, initI18n, initialLocale } from './i18n';
import { API_BASE } from './lib/config';
import { watchErrors } from './lib/error-reporting';
import './styles.css';

watchErrors(API_BASE);

const icon = document.createElement('link');
icon.rel = 'icon';
icon.type = 'image/svg+xml';
icon.href = favicon;
document.head.append(icon);

const locale = initialLocale();
applyLocale(locale);
await initI18n(locale);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
