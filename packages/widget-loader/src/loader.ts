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
 * (W19), says when a reply arrives while the chat is closed (a preview over the launcher, the tab's
 * title and, when the visitor keeps it on, a short sound), and exposes `window.Hamnivo`: open,
 * close, toggle, show, hide, isOpen, getState, setLocale, prefill, identify, reset and events.
 */
import { isFullScreen, type Mode, placement, type Viewport } from './placement.js';
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

/** How long identify() and reset() wait for the chat before rejecting with Error('timeout'). */
const REQUEST_TIMEOUT_MS = 20_000;
/** How long the launcher waits for the brand's settings before using its own defaults. */
const CONFIG_TIMEOUT_MS = 3_000;
const MODES: Mode[] = ['bubble', 'panel', 'inline', 'fullpage'];

interface LauncherConfig {
  layout: { mode: Mode; position: 'bottom-right' | 'bottom-left' };
  launcher: {
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
  /** Shows or hides the launcher (and the chat with it); `data-hidden="true"` starts hidden. */
  show(): void;
  hide(): void;
  isOpen(): boolean;
  getState(): { open: boolean; hidden: boolean; unread: number; mode: Mode };
  /** The chat's language, from now on: en, ar, hi or ur. */
  setLocale(locale: string): void;
  /** Types words in the message box and opens the chat; the visitor chooses to send them. */
  prefill(text: string): void;
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
  let locale = data.locale ?? document.documentElement.lang;
  const listeners = new Map<string, Set<Listener>>();
  const waiting = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let queue: Record<string, unknown>[] = [];
  let ready = false;
  let open = false;
  let frame: HTMLIFrameElement | null = null;
  let mode: Mode = 'bubble';
  let side = 'right';
  let unread = 0;
  let hidden = data.hidden === 'true';
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

  /** The page's own overflow while a full-screen chat holds it still; null when not held. */
  let heldOverflow: string | null = null;
  const holdPage = (hold: boolean) => {
    const root = document.documentElement.style;
    if (hold && heldOverflow === null) {
      heldOverflow = root.overflow;
      root.overflow = 'hidden';
    } else if (!hold && heldOverflow !== null) {
      root.overflow = heldOverflow;
      heldOverflow = null;
    }
  };

  /**
   * Places the frame for the screen (see placement.ts): full screen on phones, sideways phones and
   * zoomed windows, sized to the visible area so the keyboard hides nothing. While it covers the
   * page, the page behind it does not scroll.
   */
  const fit = () => {
    if (!frame || mode === 'inline') return;
    const visual = window.visualViewport;
    const viewport: Viewport = {
      width: innerWidth,
      height: innerHeight,
      visibleHeight: visual?.height ?? innerHeight,
      visibleTop: visual?.offsetTop ?? 0,
    };
    const css = placement(mode, viewport, side === 'left' ? 'left' : 'right');
    if (css) style(frame, css);
    holdPage(open && isFullScreen(mode, viewport));
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
        // Never taller than a phone's screen, so the message box stays in view.
        'max-height': data.height ? '100%' : 'calc(100dvh - 24px)',
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

  /** "(2) Page title" while replies wait, unless the site turns it off (data-title-alert="off"). */
  let written: string | null = null;
  const showTitle = () => {
    if (data.titleAlert === 'off') return;
    // Only the count this loader wrote comes off: a title the page set since then stays whole.
    const ours = written !== null && document.title === written;
    const base = ours ? document.title.replace(/^\(\d+\+?\) /, '') : document.title;
    const title = unread > 0 ? `(${unread > 9 ? '9+' : unread}) ${base}` : base;
    written = unread > 0 ? title : null;
    if (document.title !== title) document.title = title;
  };

  /** A short two-note sound. Browsers allow it only after a tap, such as opening the chat. */
  let audio: AudioContext | undefined;
  const prepareSound = () => {
    try {
      audio ??= new AudioContext();
      void audio.resume();
    } catch {
      // No Web Audio here: replies are still shown and counted.
    }
  };
  const chime = () => {
    if (audio?.state !== 'running' || data.sound === 'off') return;
    const start = audio.currentTime;
    for (const [index, pitch] of [660, 880].entries()) {
      const at = start + index * 0.12;
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.frequency.value = pitch;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      tone.connect(gain).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.22);
    }
  };

  const showBadge = () => {
    showTitle();
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
    // A reply's preview is not one of the brand's prompts: closing it changes no prompt limits.
    const reply = prompt?.hasAttribute('data-hamnivo-reply');
    hidePrompt();
    if (!reply) {
      memory = dismissed(memory, Date.now(), config?.proactive.dismissHours ?? 24);
      remember(memory);
    }
    button.focus();
  };
  /** The speech bubble next to the launcher; `opened` runs when the visitor chooses it. */
  const bubble = (text: string, opened: () => void): HTMLDivElement => {
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
      prepareSound();
      hidePrompt();
      opened();
      setOpen(true);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', config?.launcher.dismissLabel ?? 'Dismiss');
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
    return prompt;
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
      hidden ||
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
    if (open || hidden || !launcherMode() || prompt) return;
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
        const count = Math.max(0, Math.min(999, Math.trunc(Number(payload.count) || 0)));
        const grew = count > unread;
        unread = count;
        showBadge();
        // A new reply while the chat is closed or the tab is in the background: say so.
        if (grew) {
          if (payload.sound === true) chime();
          const label = typeof payload.label === 'string' ? payload.label.slice(0, 160) : '';
          if (!open && !hidden && label && launcherMode()) {
            if (prompt?.hasAttribute('data-hamnivo-reply')) hidePrompt();
            if (!prompt) bubble(label, () => undefined).setAttribute('data-hamnivo-reply', '');
          }
        }
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
      fit();
      onMounted();
      return;
    }
    button.type = 'button';
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
    button.addEventListener('click', () => {
      prepareSound();
      setOpen(!open);
    });
    if (hidden) button.style.display = 'none';
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

  /** Launcher and chat out of sight, or back (launcher modes; inline and full page stay). */
  const setHidden = (next: boolean) => {
    if (!launcherMode()) return;
    hidden = next;
    if (next) {
      setOpen(false);
      hidePrompt();
    }
    button.style.display = next ? 'none' : 'flex';
  };

  window.Hamnivo = {
    loaded: true,
    open: () => {
      if (!hidden) setOpen(true);
    },
    close: () => setOpen(false),
    toggle: () => {
      if (!hidden) setOpen(!open);
    },
    show: () => void mounted.then(() => setHidden(false)),
    hide: () => void mounted.then(() => setHidden(true)),
    isOpen: () => open,
    getState: () => ({ open, hidden, unread, mode }),
    setLocale: (next) => {
      const short = String(next).slice(0, 2).toLowerCase();
      if (!['en', 'ar', 'hi', 'ur'].includes(short)) return;
      // Before the chat loads it is only remembered: nothing loads early for it.
      locale = short;
      if (frame) send({ type: 'set-locale', locale: short });
    },
    prefill: (text) => {
      const words = String(text ?? '')
        .trim()
        .slice(0, 2000);
      if (!words) return;
      void mounted.then(() => {
        ensureFrame();
        send({ type: 'prefill', text: words });
        if (!hidden) setOpen(true);
      });
    },
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
