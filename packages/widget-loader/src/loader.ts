/**
 * Hamnivo chat loader (blueprint §10). Add to a page:
 *
 *   <script src="https://chat.example.com/loader.js" data-widget-id="wid_…" async></script>
 *
 * It reads the brand's layout (W02) and places the chat as a floating launcher (`bubble`), a side
 * `panel`, `inline` in an element of the page, or the whole page (`fullpage`); `data-mode`
 * overrides the brand's choice. Launcher modes create the chat iframe only when the visitor opens
 * it, so nothing else loads before then. Messages to and from the iframe are checked for origin,
 * window and instance. It shows the unread count on the launcher and the brand's proactive prompts
 * (W19), and exposes `window.Hamnivo` for open, close, identify, reset and events.
 */
import {
  dismissed,
  eligible,
  type Memory,
  type Page,
  type ProactiveConfig,
  type Rule,
  shown,
  visit,
} from './proactive.js';
import { track } from './visitor.js';

type Listener = (payload: Record<string, unknown>) => void;
type Mode = 'bubble' | 'panel' | 'inline' | 'fullpage';

/** How long identify() and reset() wait for the chat before rejecting with Error('timeout'). */
const REQUEST_TIMEOUT_MS = 20_000;
/** How long the launcher waits for the brand's settings before using its own defaults. */
const CONFIG_TIMEOUT_MS = 3_000;
const MODES: Mode[] = ['bubble', 'panel', 'inline', 'fullpage'];

interface LauncherConfig {
  dir?: 'ltr' | 'rtl';
  layout: { mode: Mode; position: 'bottom-right' | 'bottom-left' };
  launcher: {
    label?: string | null;
    fontFamily?: 'system' | 'dm-sans' | 'noto-sans';
    accent: string;
    onAccent: string;
    openLabel: string;
    closeLabel: string;
    title: string;
    dismissLabel: string;
    unreadLabel: string;
  };
  proactive: ProactiveConfig;
}

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
  // The settings are the script's data-* attributes. Where a platform cannot set them (Google Tag
  // Manager's injectScript can only pass an address), the same names work in the query of the
  // script's own address: loader.js?widgetId=wid_…&api=https://api.example.com. Attributes win.
  const query = (() => {
    try {
      return Object.fromEntries(new URL(script.src, location.href).searchParams);
    } catch {
      return {};
    }
  })();
  const data: DOMStringMap = { ...query, ...script.dataset };
  const widgetId = data.widgetId;
  if (!widgetId) {
    console.error('Hamnivo: add data-widget-id to the loader script');
    return;
  }
  const widgetOrigin = new URL(data.widgetOrigin ?? script.src, location.href).origin;
  const instanceId = Math.random().toString(36).slice(2, 12);
  const locale = data.locale ?? document.documentElement.lang;
  const listeners = new Map<string, Set<Listener>>();
  const waiting = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let queue: Record<string, unknown>[] = [];
  let ready = false;
  let open = false;
  let frame: HTMLIFrameElement | null = null;
  let mode: Mode = 'bubble';
  let side = 'right';
  let unread = 0;
  let config: LauncherConfig | null = null;
  let onMounted: () => void = () => undefined;
  /** The chat is placed once the brand's layout is known; requests made before then wait. */
  const mounted = new Promise<void>((resolve) => {
    onMounted = resolve;
  });
  const label = (
    key: keyof LauncherConfig['launcher'],
    attr: string | undefined,
    fallback: string,
  ) => attr ?? config?.launcher[key] ?? fallback;
  const openLabel = () => label('openLabel', data.label, 'Open chat');

  const emit = (event: string, payload: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };

  const style = (element: HTMLElement, css: Record<string, string>) => {
    for (const [k, v] of Object.entries(css)) element.style.setProperty(k, v);
  };
  const launcherMode = () => mode === 'bubble' || mode === 'panel';

  const button = document.createElement('button');
  const badge = document.createElement('span');

  const send = (message: Record<string, unknown>) => {
    const full = { source: 'hamnivo', v: 1, instanceId, ...message };
    if (ready && frame?.contentWindow) frame.contentWindow.postMessage(full, widgetOrigin);
    else queue.push(full);
  };

  /** Full screen on small screens, sized to the visible area so the keyboard hides nothing. */
  const fit = () => {
    if (!frame) return;
    const viewport = window.visualViewport;
    const full =
      mode === 'fullpage' || (launcherMode() && matchMedia('(max-width: 480px)').matches);
    if (mode === 'inline') return;
    if (full) {
      style(frame, {
        top: `${viewport?.offsetTop ?? 0}px`,
        left: '0',
        right: 'auto',
        bottom: 'auto',
        width: '100%',
        height: `${viewport?.height ?? innerHeight}px`,
        'border-radius': '0',
      });
    } else if (mode === 'panel') {
      style(frame, {
        top: '0',
        bottom: 'auto',
        left: side === 'left' ? '0' : 'auto',
        right: side === 'right' ? '0' : 'auto',
        width: 'min(420px, 100%)',
        height: `${viewport?.height ?? innerHeight}px`,
        'border-radius': '0',
      });
    } else {
      style(frame, {
        top: 'auto',
        bottom: '88px',
        left: side === 'left' ? '20px' : 'auto',
        right: side === 'right' ? '20px' : 'auto',
        width: 'min(400px, calc(100vw - 32px))',
        height: 'min(640px, calc(100vh - 112px))',
        'border-radius': '16px',
      });
    }
  };

  const ensureFrame = (): HTMLIFrameElement => {
    if (frame) return frame;
    const params = new URLSearchParams({
      widgetId,
      host: location.origin,
      instance: instanceId,
      mode,
    });
    if (locale) params.set('locale', locale);
    if (data.api) params.set('api', data.api);
    frame = document.createElement('iframe');
    frame.title = label('title', data.title, 'Chat');
    frame.src = `${widgetOrigin}/?${params}`;
    frame.setAttribute('data-hamnivo-frame', '');
    style(frame, { border: '0', background: '#fff' });
    if (mode === 'inline') {
      style(frame, {
        display: 'block',
        width: '100%',
        height: data.height ?? '600px',
        'max-height': '100%',
        'border-radius': '12px',
        border: '1px solid rgba(0,0,0,.12)',
      });
      const container = data.container ? document.querySelector(data.container) : null;
      if (container) container.appendChild(frame);
      else script.parentNode?.insertBefore(frame, script.nextSibling);
    } else {
      style(frame, {
        position: 'fixed',
        'box-shadow': '0 12px 40px rgba(0,0,0,.25)',
        display: 'none',
        'z-index': '2147483000',
      });
      document.body.appendChild(frame);
    }
    fit();
    return frame;
  };

  const showBadge = () => {
    const count = open ? 0 : unread;
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.style.display = count > 0 ? 'flex' : 'none';
    const words = config?.launcher.unreadLabel ?? '{count} unread';
    button.setAttribute(
      'aria-label',
      open
        ? label('closeLabel', data.closeLabel, 'Close chat')
        : count > 0
          ? `${openLabel()}, ${words.replace('{count}', String(count))}`
          : openLabel(),
    );
  };

  // ---------------------------------------------------------------- proactive prompts (W19)
  const memoryKey = `hamnivo:${widgetId}:proactive`;
  const remember = (memory: Memory) => {
    try {
      localStorage.setItem(memoryKey, JSON.stringify(memory));
    } catch {
      // No storage: prompts are still limited within this page view.
    }
  };
  const recall = (): Memory | null => {
    try {
      return JSON.parse(localStorage.getItem(memoryKey) ?? 'null') as Memory | null;
    } catch {
      return null;
    }
  };
  let memory = visit(recall(), new Date());
  remember(memory);
  let prompt: HTMLDivElement | null = null;
  let prompted = false;
  const timers: number[] = [];

  const hidePrompt = () => {
    prompt?.remove();
    prompt = null;
  };
  const dismissPrompt = () => {
    hidePrompt();
    memory = dismissed(memory, Date.now(), config?.proactive.dismissHours ?? 24);
    remember(memory);
    button.focus();
  };
  /** The speech bubble next to the launcher; `opened` runs when the visitor chooses it. */
  const bubble = (text: string, opened: () => void) => {
    if (!config) return;
    prompt = document.createElement('div');
    prompt.setAttribute('data-hamnivo-prompt', '');
    prompt.setAttribute('role', 'status');
    prompt.lang = locale ?? '';
    prompt.dir = 'auto';
    style(prompt, {
      position: 'fixed',
      bottom: '88px',
      [side]: '20px',
      'max-width': 'min(300px, calc(100vw - 40px))',
      display: 'flex',
      gap: '4px',
      'align-items': 'flex-start',
      background: '#fff',
      color: '#192A30',
      'border-radius': '12px',
      'box-shadow': '0 6px 20px rgba(0,0,0,.2)',
      padding: '4px',
      font: '15px/1.4 system-ui, sans-serif',
      'z-index': '2147483000',
    });
    const message = document.createElement('button');
    message.type = 'button';
    message.textContent = text;
    style(message, {
      background: 'none',
      border: '0',
      color: 'inherit',
      font: 'inherit',
      'text-align': 'start',
      padding: '8px',
      cursor: 'pointer',
      'min-height': '44px',
    });
    message.addEventListener('click', () => {
      hidePrompt();
      opened();
      setOpen(true);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', config.launcher.dismissLabel);
    style(close, {
      background: 'none',
      border: '0',
      color: 'inherit',
      font: '20px/1 system-ui, sans-serif',
      width: '44px',
      height: '44px',
      cursor: 'pointer',
      'flex-shrink': '0',
    });
    close.addEventListener('click', dismissPrompt);
    prompt.append(message, close);
    document.body.appendChild(prompt);
  };
  const page = (): Page => ({
    path: location.pathname + location.search,
    referrer: document.referrer,
    width: window.innerWidth,
  });
  const showPrompt = (rule: Rule) => {
    // Once per page view, never over an open chat, and within today's limit.
    if (
      prompted ||
      open ||
      !config ||
      !eligible(config.proactive, memory, Date.now(), page()).includes(rule)
    )
      return;
    prompted = true;
    memory = shown(memory);
    remember(memory);
    bubble(rule.message, () => send({ type: 'proactive', triggerId: rule.id }));
  };
  /** Staff invited this visitor to chat: shown like a prompt, but not counted against the limits. */
  const showInvite = (message: string) => {
    if (open || !launcherMode() || prompt) return;
    bubble(message, () => undefined);
  };
  const schedulePrompts = () => {
    if (!config || !launcherMode()) return;
    for (const rule of eligible(config.proactive, memory, Date.now(), page())) {
      timers.push(window.setTimeout(() => showPrompt(rule), rule.seconds * 1000));
    }
  };

  // ---------------------------------------------------------------- opening and closing
  const setOpen = (next: boolean) => {
    if (!launcherMode()) return;
    if (open === next) return;
    open = next;
    hidePrompt();
    const f = ensureFrame();
    f.style.display = next ? 'block' : 'none';
    fit();
    button.setAttribute('aria-expanded', String(next));
    showBadge();
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
      void mounted.then(() => {
        ensureFrame();
        send({ ...message, requestId });
      });
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
      const payload = (m.payload as Record<string, unknown>) ?? {};
      if (m.event === 'unread') {
        unread = Math.max(0, Math.min(999, Math.trunc(Number(payload.count) || 0)));
        showBadge();
      }
      emit(m.event, payload);
    } else if (m.type === 'result' && typeof m.requestId === 'string') {
      const entry = waiting.get(m.requestId);
      waiting.delete(m.requestId);
      if (m.ok) entry?.resolve();
      else entry?.reject(new Error(String(m.error ?? 'failed')));
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (prompt) dismissPrompt();
    else if (open) setOpen(false);
  });
  window.visualViewport?.addEventListener('resize', fit);
  window.visualViewport?.addEventListener('scroll', fit);
  window.addEventListener('resize', fit);

  // ---------------------------------------------------------------- start
  const mount = () => {
    const requested = data.mode as Mode | undefined;
    mode = requested && MODES.includes(requested) ? requested : (config?.layout.mode ?? 'bubble');
    side = (data.position ?? config?.layout.position) === 'bottom-left' ? 'left' : 'right';
    if (!launcherMode()) {
      ensureFrame().style.display = 'block';
      open = true;
      onMounted();
      return;
    }
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('data-hamnivo-launcher', '');
    button.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/></svg>';
    const launcherLabel = config?.launcher.label;
    button.dir = config?.dir ?? document.documentElement.dir;
    if (config?.launcher.fontFamily && config.launcher.fontFamily !== 'system') {
      const fonts = document.createElement('link');
      fonts.rel = 'stylesheet';
      fonts.href = new URL('/launcher-fonts.css', widgetOrigin).href;
      document.head.appendChild(fonts);
    }
    if (launcherLabel) {
      const text = document.createElement('span');
      text.textContent = launcherLabel;
      text.dir = 'auto';
      text.setAttribute('data-hamnivo-launcher-label', '');
      style(text, {
        'max-width': 'min(180px, 45vw)',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap',
      });
      button.appendChild(text);
    }
    style(button, {
      position: 'fixed',
      bottom: '20px',
      [side]: '20px',
      width: launcherLabel ? 'auto' : '56px',
      padding: launcherLabel ? '0 18px' : '0',
      gap: '10px',
      font:
        config?.launcher.fontFamily === 'dm-sans'
          ? '600 14px/1.4 "Hamnivo DM Sans", "DM Sans Variable", system-ui, sans-serif'
          : config?.launcher.fontFamily === 'noto-sans'
            ? '600 14px/1.4 "Hamnivo Noto Sans", "Noto Sans", system-ui, sans-serif'
            : '600 14px/1.4 system-ui, sans-serif',
      height: '56px',
      'border-radius': launcherLabel ? '28px' : '50%',
      border: '0',
      background: data.color ?? config?.launcher.accent ?? '#192A30',
      color: config?.launcher.onAccent ?? '#fff',
      cursor: 'pointer',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      'box-shadow': '0 6px 20px rgba(0,0,0,.2)',
      'z-index': '2147483000',
    });
    badge.setAttribute('aria-hidden', 'true');
    badge.setAttribute('data-hamnivo-unread', '');
    style(badge, {
      position: 'absolute',
      top: '-4px',
      [side === 'right' ? 'left' : 'right']: '-4px',
      'min-width': '22px',
      height: '22px',
      padding: '0 6px',
      'border-radius': '11px',
      background: '#B42318',
      color: '#fff',
      font: '700 12px/22px system-ui, sans-serif',
      display: 'none',
      'justify-content': 'center',
    });
    button.appendChild(badge);
    button.addEventListener('click', () => setOpen(!open));
    showBadge();
    document.body.appendChild(button);
    onMounted();
    schedulePrompts();
  };

  // Which page the visitor is on, for the brand's staff (see visitor.ts); never with Do Not Track.
  const watchVisitor = () => {
    const api = data.api?.replace(/\/$/, '');
    if (!api || data.visitors === 'off') return;
    const url = `${api}/v1/widget/visits`;
    const type = 'text/plain;charset=UTF-8';
    const invited = new Set<string>();
    track({
      widgetId,
      page: () => ({
        url: location.href,
        title: document.title,
        referrer: document.referrer,
        language: navigator.language,
      }),
      optOut: () => {
        const n = navigator as Navigator & { globalPrivacyControl?: boolean };
        return (
          n.doNotTrack === '1' ||
          (window as Window & { doNotTrack?: string }).doNotTrack === '1' ||
          n.globalPrivacyControl === true
        );
      },
      visible: () => document.visibilityState === 'visible',
      listen: (event, handler) => {
        const target = event === 'pagehide' ? window : document;
        target.addEventListener(event, handler);
        return () => target.removeEventListener(event, handler);
      },
      storage: {
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
      },
      random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
      post: (body) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': type },
          body,
          credentials: 'omit',
          keepalive: true,
        })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      beacon: (body) => navigator.sendBeacon?.(url, new Blob([body], { type })),
      onTracking: (key) => send({ type: 'visitor', key }),
      onInvite: (invite) => {
        if (!invited.has(invite.id)) {
          invited.add(invite.id);
          showInvite(invite.message);
        }
      },
    });
  };

  const start = () => {
    watchVisitor();
    if (!data.api) {
      mount();
      return;
    }
    const query = new URLSearchParams({ widgetId });
    if (locale && ['en', 'ar', 'hi', 'ur'].includes(locale.slice(0, 2))) {
      query.set('locale', locale.slice(0, 2));
    }
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      mount();
    };
    const timer = setTimeout(go, CONFIG_TIMEOUT_MS);
    fetch(`${data.api.replace(/\/$/, '')}/v1/widget/launcher?${query}`, { credentials: 'omit' })
      .then((response) => (response.ok ? response.json() : null))
      .then((loaded: LauncherConfig | null) => {
        config = loaded;
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        go();
      });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

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
