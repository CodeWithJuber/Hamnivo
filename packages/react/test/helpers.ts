import { type Mock, vi } from 'vitest';

export const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
export const CHAT = 'https://chat.example.com';

type Listener = (payload: Record<string, unknown>) => void;

/** What the real loader puts on window.Hamnivo, with every call recorded. */
export interface FakeApi {
  loaded: true;
  open: Mock<() => void>;
  close: Mock<() => void>;
  toggle: Mock<() => void>;
  identify: Mock<(assertion: string) => Promise<void>>;
  reset: Mock<() => Promise<void>>;
  on: (event: string, listener: Listener) => () => void;
}

/** A stand-in for the loader, with a way to send it events as the chat frame would. */
export function fakeLoader(): {
  api: FakeApi;
  emit: (event: string, payload?: Record<string, unknown>) => void;
} {
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, payload: Record<string, unknown> = {}) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
  };
  const api: FakeApi = {
    loaded: true,
    open: vi.fn(() => emit('open')),
    close: vi.fn(() => emit('close')),
    toggle: vi.fn(),
    identify: vi.fn(async (_assertion: string) => emit('identity.changed', { verified: true })),
    reset: vi.fn(async () => emit('identity.changed', { verified: false })),
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    },
  };
  return { api, emit };
}

/** The script the package added to the page, or undefined. */
export const injectedScript = (): HTMLScriptElement | undefined =>
  document.querySelector<HTMLScriptElement>('script[data-widget-id]') ?? undefined;

/** Does what the browser does when the script has run and the loader has started. */
export function startLoader(api: FakeApi): void {
  (window as unknown as { Hamnivo?: unknown }).Hamnivo = api;
  injectedScript()?.dispatchEvent(new Event('load'));
}

/** Does what the browser does when the script cannot be loaded. */
export function failLoader(): void {
  injectedScript()?.dispatchEvent(new Event('error'));
}

export function resetPage(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'Hamnivo');
  window.localStorage.clear();
}

/** Lets the promises that are waiting run. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
