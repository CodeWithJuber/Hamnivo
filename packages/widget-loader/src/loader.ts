/**
 * Hamnivo chat loader (blueprint §10). Add to a page:
 *
 *   <script src="https://chat.example.com/loader.js" data-widget-id="wid_…" async></script>
 *
 * It adds an accessible launcher button and creates the chat iframe only when the visitor opens
 * it, so nothing else loads before then. Messages to and from the iframe are checked for origin,
 * window and instance. It exposes `window.Hamnivo` for open, close, identify, reset and events.
 */

type Listener = (payload: Record<string, unknown>) => void;

/** How long identify() and reset() wait for the chat before rejecting with Error('timeout'). */
const REQUEST_TIMEOUT_MS = 20_000;

interface HamnivoApi {
  loaded: true;
  open(): void;
  close(): void;
  toggle(): void;
  identify(assertion: string): Promise<void>;
  reset(): Promise<void>;
  on(event: string, listener: Listener): () => void;
}

declare global {
  interface Window {
    Hamnivo?: HamnivoApi;
  }
}

(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script || window.Hamnivo?.loaded) return;
  const data = script.dataset;
  const widgetId = data.widgetId;
  if (!widgetId) {
    console.error('Hamnivo: add data-widget-id to the loader script');
    return;
  }
  const widgetOrigin = new URL(data.widgetOrigin ?? script.src, location.href).origin;
  const instanceId = Math.random().toString(36).slice(2, 12);
  const side = data.position === 'bottom-left' ? 'left' : 'right';
  const color = data.color ?? '#192A30';
  const listeners = new Map<string, Set<Listener>>();
  const waiting = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let queue: Record<string, unknown>[] = [];
  let ready = false;
  let open = false;
  let frame: HTMLIFrameElement | null = null;

  const emit = (event: string, payload: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };

  const style = (element: HTMLElement, css: Record<string, string>) => {
    for (const [k, v] of Object.entries(css)) element.style.setProperty(k, v);
  };

  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', data.label ?? 'Open chat');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('data-hamnivo-launcher', '');
  button.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/></svg>';
  style(button, {
    position: 'fixed',
    bottom: '20px',
    [side]: '20px',
    width: '56px',
    height: '56px',
    'border-radius': '50%',
    border: '0',
    background: color,
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    'box-shadow': '0 6px 20px rgba(0,0,0,.2)',
    'z-index': '2147483000',
  });

  const send = (message: Record<string, unknown>) => {
    const full = { source: 'hamnivo', v: 1, instanceId, ...message };
    if (ready && frame?.contentWindow) frame.contentWindow.postMessage(full, widgetOrigin);
    else queue.push(full);
  };

  const ensureFrame = (): HTMLIFrameElement => {
    if (frame) return frame;
    const params = new URLSearchParams({ widgetId, host: location.origin, instance: instanceId });
    const locale = data.locale ?? document.documentElement.lang;
    if (locale) params.set('locale', locale);
    if (data.api) params.set('api', data.api);
    frame = document.createElement('iframe');
    frame.title = data.title ?? 'Chat';
    frame.src = `${widgetOrigin}/?${params}`;
    frame.setAttribute('data-hamnivo-frame', '');
    style(frame, {
      position: 'fixed',
      bottom: '88px',
      [side]: '20px',
      width: 'min(400px, calc(100vw - 32px))',
      height: 'min(640px, calc(100vh - 112px))',
      border: '0',
      'border-radius': '16px',
      'box-shadow': '0 12px 40px rgba(0,0,0,.25)',
      background: '#fff',
      display: 'none',
      'z-index': '2147483000',
    });
    document.body.appendChild(frame);
    return frame;
  };

  const setOpen = (next: boolean) => {
    if (open === next) return;
    open = next;
    const f = ensureFrame();
    f.style.display = next ? 'block' : 'none';
    button.setAttribute('aria-expanded', String(next));
    button.setAttribute(
      'aria-label',
      next ? (data.closeLabel ?? 'Close chat') : (data.label ?? 'Open chat'),
    );
    send({ type: next ? 'open' : 'close' });
    emit(next ? 'open' : 'close');
    if (next) f.focus();
    else button.focus();
  };

  // A chat that never answers (blocked, offline, still loading) must not keep the page waiting.
  const request = (message: Record<string, unknown>) =>
    new Promise<void>((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2, 12);
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error('timeout'));
      }, REQUEST_TIMEOUT_MS);
      const settle = () => clearTimeout(timer);
      waiting.set(requestId, {
        resolve: () => {
          settle();
          resolve();
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      ensureFrame();
      send({ ...message, requestId });
    });

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== widgetOrigin || !frame || event.source !== frame.contentWindow) return;
    const m = event.data as Record<string, unknown> | null;
    if (m?.source !== 'hamnivo' || m.v !== 1 || m.instanceId !== instanceId) return;
    if (m.type === 'ready') {
      ready = true;
      const pending = queue;
      queue = [];
      for (const message of pending) frame.contentWindow?.postMessage(message, widgetOrigin);
      emit('ready');
    } else if (m.type === 'layout' && m.open === false) {
      setOpen(false);
    } else if (m.type === 'event' && typeof m.event === 'string') {
      emit(m.event, (m.payload as Record<string, unknown>) ?? {});
    } else if (m.type === 'result' && typeof m.requestId === 'string') {
      const entry = waiting.get(m.requestId);
      waiting.delete(m.requestId);
      if (m.ok) entry?.resolve();
      else entry?.reject(new Error(String(m.error ?? 'failed')));
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) setOpen(false);
  });
  button.addEventListener('click', () => setOpen(!open));

  const mount = () => document.body.appendChild(button);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  window.Hamnivo = {
    loaded: true,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    identify: (assertion) => request({ type: 'identify', assertion }),
    reset: () => request({ type: 'reset' }),
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
  };
})();
