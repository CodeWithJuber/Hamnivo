import { useSyncExternalStore } from 'react';

export type DocumentTheme = 'light' | 'dark';

function read(): DocumentTheme {
  if (typeof document === 'undefined') return 'light';
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark' || explicit === 'light') return explicit;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', onChange);
  };
}

/**
 * Resolved colour theme: the `data-theme` attribute on <html> wins, otherwise the OS preference.
 * Mirrors the rules in @hamnivo/brand/tokens.css.
 */
export function useDocumentTheme(): DocumentTheme {
  return useSyncExternalStore(subscribe, read, () => 'light');
}
