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
 * close, toggle, show, hide, isOpen, getState, setLocale, prefill, identify, reset, events and
 * destroy.
 *
 * It is made to work on any website:
 * - The launcher, its unread count and the prompts live in a shadow root, so the page's own
 *   styles do not reach them; the chat frame starts from `all: initial` and keeps its place with
 *   `!important`. Everything is styled property by property and drawn with DOM calls, so a strict
 *   Content-Security-Policy and Trusted Types need no exception for it.
 * - The chat is told whether the page is light or dark (`data-theme` to decide it yourself).
 * - On a page that changes without loading (a single-page app) the prompts and the pages the
 *   chat is kept off (`data-hide-on`) follow the address, and the launcher is put back if the
 *   page's framework removes it.
 */
import { hiddenOn } from './pages.js';
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
import { type Scheme, schemeOf } from './theme.js';
import { track } from './visitor.js';

type Listener = (payload: Record<string, unknown>) => void;
type Css = Record<string, string>;

/** How long identify() and reset() wait for the chat before rejecting with Error('timeout'). */
const REQUEST_TIMEOUT_MS = 20_000;
/** How long the launcher waits for the brand's settings before using its own defaults. */
const CONFIG_TIMEOUT_MS = 3_000;
/** How long a visitor counts as being in a conversation, so the chat loads quietly for them. */
const LIVE_MS = 7 * 86_400_000;
const MODES: Mode[] = ['bubble', 'panel', 'inline', 'fullpage'];
const SIZES: Record<string, number> = { small: 48, medium: 56, large: 64 };
/** The launcher's pictures, as one path each on a 24 px grid. */
const ICONS: Record<string, string> = {
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z',
  message: 'M4 5h16v11H10l-5 4v-4H4z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.2 1-1.2 1.8M12 17h.01',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2zM19 3v4M17 5h4',
};
const CLOSE = 'M6 6l12 12M18 6 6 18';
const SHADOW = '0 6px 20px rgba(0,0,0,.2)';
/** What a page's own rules must not change about the two elements the chat keeps in the page. */
const FIRM: Css = {
  margin: '0',
  padding: '0',
  'max-width': 'none',
  'min-width': '0',
  'min-height': '0',
  float: 'none',
  'clip-path': 'none',
  filter: 'none',
  transform: 'none',
  opacity: '1',
};
const SVG = 'http://www.w3.org/2000/svg';

interface LauncherConfig {
  dir?: 'ltr' | 'rtl';
  /** The brand's choice of a light or dark chat; `auto`, or nothing, follows the page. */
  theme?: 'light' | 'dark' | 'auto';
  layout: {
    mode: Mode;
    position: 'bottom-right' | 'bottom-left';
    offset?: { x: number; y: number };
    hideOnMobile?: boolean;
  };
  launcher: {
    label?: string | null;
    fontFamily?: 'system' | 'dm-sans' | 'noto-sans';
    icon?: string;
    size?: string;
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
  off(event: string, listener: Listener): void;
  /** Takes the chat off the page for good: its launcher, its frame and everything it listens to. */
  destroy(): void;
}

declare global {
  interface Window {
    Hamnivo?: HamnivoApi;
  }
}

(() => {
  const doc = document;
  // Some tag managers and module scripts run without `currentScript`: the tag is found by what
  // every install has, its widget ID.
  const script = (doc.currentScript ??
    doc.querySelector(
      'script[data-widget-id],script[src*="widgetId="]',
    )) as HTMLScriptElement | null;
  if (!script) return;
  if (window.Hamnivo?.loaded) {
    console.warn('Hamnivo: the loader is on this page twice; the second one does nothing');
    return;
  }
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
  const api = data.api?.replace(/\/$/, '');
  const instanceId = Math.random().toString(36).slice(2, 12);
  let locale = data.locale ?? doc.documentElement.lang;
  const listeners = new Map<string, Set<Listener>>();
  const waiting = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  /** Everything this loader listens to ends with it (`Hamnivo.destroy`). */
  const life = new AbortController();
  const on = (target: EventTarget | null | undefined, event: string, run: (e: Event) => void) =>
    target?.addEventListener?.(event, run, { signal: life.signal });
  const media = (query: string) => window.matchMedia?.(query);
  const calm = () => media('(prefers-reduced-motion: reduce)')?.matches === true;
  let queue: Record<string, unknown>[] = [];
  let ready = false;
  let open = false;
  let frame: HTMLIFrameElement | null = null;
  let mode: Mode = 'bubble';
  let side: 'left' | 'right' = 'right';
  let x = 20;
  let y = 20;
  let size = 56;
  let unread = 0;
  /** The website hid the chat (`Hamnivo.hide`, `data-hidden`). */
  let hidden = data.hidden === 'true';
  /** This page is one the chat is kept off (`data-hide-on`, hidden on phones). */
  let away = false;
  /** The open chat covers the launcher (full screen, or a side panel), so it is put away. */
  let covered = false;
  /** An older @hamnivo/react or @hamnivo/vue hid the chat with its own style rule. */
  let wrapped = false;
  let printing = false;
  let expanded = false;
  let scheme: Scheme = 'light';
  let config: LauncherConfig | null = null;
  let isMounted = false;
  let onMounted: () => void = () => undefined;
  /** The chat is placed once the brand's layout is known; requests made before then wait. */
  const mounted = new Promise<void>((resolve) => {
    onMounted = () => {
      isMounted = true;
      resolve();
    };
  });
  const whenMounted = (run: () => void) => (isMounted ? run() : void mounted.then(run));
  const label = (
    key: 'openLabel' | 'closeLabel' | 'title',
    attr: string | undefined,
    fallback: string,
  ) => attr ?? config?.launcher[key] ?? fallback;
  const openLabel = () => label('openLabel', data.label, 'Open chat');

  const emit = (event: string, payload: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };

  /** Styles are set one property at a time: no style element or attribute for a CSP to refuse. */
  const style = (element: HTMLElement | SVGElement, css: Css, important = false) => {
    for (const [k, v] of Object.entries(css)) {
      element.style.setProperty(k, v, important ? 'important' : '');
    }
  };
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, css?: Css) => {
    const element = doc.createElement(tag);
    if (css) style(element, css);
    return element;
  };
  /** A short entrance; nothing moves for a visitor who asked their device for less motion. */
  const animate = (element: Element, from: Keyframe, ms = 180) => {
    if (!calm())
      element.animate?.([from, {}], { duration: ms, easing: 'cubic-bezier(.2,.8,.2,1)' });
  };
  const launcherMode = () => mode === 'bubble' || mode === 'panel';
  const out = () => hidden || away;

  // The launcher, its unread count and the prompts: in a shadow root, apart from the page's CSS.
  const root = make('div');
  root.setAttribute('data-hamnivo-root', '');
  const shadow: ShadowRoot | HTMLElement = root.attachShadow?.({ mode: 'open' }) ?? root;
  const button = make('button');
  const badge = make('span');
  const icon = doc.createElementNS(SVG, 'svg');
  const drawing = doc.createElementNS(SVG, 'path');
  /** Measures the screen's own edge (a phone's home bar), which the chat frame cannot see. */
  const edge = make('div', {
    position: 'fixed',
    bottom: '0',
    visibility: 'hidden',
    'padding-bottom': 'env(safe-area-inset-bottom)',
  });
  const showRoot = () =>
    style(
      root,
      {
        display: !launcherMode() || out() || covered || printing || wrapped ? 'none' : 'block',
      },
      true,
    );

  const send = (message: Record<string, unknown>) => {
    const full = { source: 'hamnivo', v: 1, instanceId, ...message };
    if (ready && frame?.contentWindow) frame.contentWindow.postMessage(full, widgetOrigin);
    else queue.push(full);
  };

  /** The page's own overflow while a full-screen chat holds it still; null when not held. */
  let held: [string, string] | null = null;
  const holdPage = (hold: boolean) => {
    const page = doc.documentElement.style;
    const body = doc.body.style;
    if (hold && !held) {
      held = [page.overflow, body.overflow];
      page.overflow = 'hidden';
      // Phones scroll the body where the root's overflow is not enough.
      body.overflow = 'hidden';
    } else if (!hold && held) {
      [page.overflow, body.overflow] = held;
      held = null;
    }
  };

  // ---------------------------------------------------------------- the page's theme
  const detect = (): Scheme => {
    const chosen = data.theme ?? config?.theme;
    if (chosen === 'light' || chosen === 'dark') return chosen;
    const seen = (element: Element) => getComputedStyle(element);
    const page = seen(doc.documentElement);
    return schemeOf(
      [seen(doc.body).backgroundColor, page.backgroundColor],
      page.colorScheme || '',
      media('(prefers-color-scheme: dark)')?.matches === true,
    );
  };
  const surface = () => (scheme === 'dark' ? '#16242A' : '#fff');
  const ink = () => (scheme === 'dark' ? '#F2EFE8' : '#192A30');
  const visible = (): Viewport => {
    const visual = window.visualViewport;
    return {
      width: innerWidth,
      height: innerHeight,
      visibleHeight: visual?.height ?? innerHeight,
      visibleTop: visual?.offsetTop ?? 0,
    };
  };

  /** What the chat cannot see from inside its frame; told again only when it changes. */
  let told = '';
  const tell = () => {
    if (!frame) return;
    const env = {
      type: 'env',
      theme: scheme,
      fullScreen: isFullScreen(mode, visible()),
      expanded,
      safeBottom: Math.round(Number.parseFloat(getComputedStyle(edge).paddingBottom) || 0),
    };
    const now = JSON.stringify(env);
    if (now === told) return;
    told = now;
    send(env);
  };

  /**
   * The page the visitor is on, for the assistant to understand what they mean: its address
   * without the query or fragment (which can hold tokens) and its title. Sent when the chat
   * loads and whenever either changes; a message the visitor sends carries it.
   */
  let placed = '';
  const tellPage = () => {
    const title = doc.title.trim().slice(0, 300);
    const context = { url: location.origin + location.pathname, ...(title ? { title } : {}) };
    const now = JSON.stringify(context);
    if (now === placed || !location.origin.startsWith('http')) return;
    placed = now;
    send({ type: 'set-context', context });
  };

  /**
   * Places the frame for the screen (see placement.ts): full screen on phones, sideways phones and
   * zoomed windows, sized to the visible area so the keyboard hides nothing. While it covers the
   * page, the page behind it does not scroll and the launcher under it is put away.
   */
  const fit = () => {
    if (!frame) return;
    const viewport = visible();
    const css = placement(mode, viewport, side, { x, y, launcher: size, expanded });
    if (css) style(frame, css, true);
    const full = isFullScreen(mode, viewport);
    covered = open && launcherMode() && (full || mode === 'panel');
    holdPage(open && mode !== 'inline' && full);
    showRoot();
    tell();
  };

  const showFrame = (f: HTMLIFrameElement, show: boolean) => {
    // `display` stays overridable, so a page can still hide the chat with its own rule;
    // `visibility` keeps a closed chat out of sight where a page forces every frame to show.
    style(f, { display: show && !printing ? 'block' : 'none' });
    style(f, { visibility: show ? 'visible' : 'hidden' }, true);
  };

  const ensureFrame = (): HTMLIFrameElement => {
    if (frame) return frame;
    const params = new URLSearchParams({
      widgetId,
      host: location.origin,
      instance: instanceId,
      mode,
      theme: scheme,
      // What this loader can do for the chat: tell it about the page, and resize it.
      caps: 'env,resize',
    });
    if (locale) params.set('locale', locale);
    if (data.api) params.set('api', data.api);
    const f = make('iframe');
    frame = f;
    f.title = label('title', data.title, 'Chat');
    f.src = `${widgetOrigin}/?${params}`;
    f.allow = 'clipboard-write';
    f.setAttribute('data-hamnivo-frame', '');
    // Nothing of the page's own rules for frames stays; what places the chat cannot be overridden.
    style(f, { all: 'initial' });
    style(
      f,
      {
        ...FIRM,
        border: '0',
        'color-scheme': 'normal',
        background: scheme === 'dark' ? '#0F1A1E' : '#F6F3EC',
      },
      true,
    );
    if (mode === 'inline') {
      style(
        f,
        {
          width: '100%',
          height: data.height ?? '600px',
          // Never taller than a phone's screen, so the message box stays in view.
          'max-height': data.height ? '100%' : 'calc(100dvh - 24px)',
          'border-radius': '12px',
          border: '1px solid rgba(0,0,0,.12)',
        },
        true,
      );
      showFrame(f, true);
    } else {
      style(
        f,
        {
          position: 'fixed',
          'max-height': 'none',
          'box-shadow': '0 12px 40px rgba(0,0,0,.25)',
          'z-index': String(zIndex()),
          'transform-origin': `bottom ${side}`,
        },
        true,
      );
      showFrame(f, false);
    }
    place(f);
    fit();
    return f;
  };
  const zIndex = () => {
    const asked = Number(data.zIndex);
    return asked > 0 && asked <= 2147483647 ? Math.trunc(asked) : 2147483000;
  };
  /** Puts the frame in the page: in the website's element for inline, at the end otherwise. */
  const place = (f: HTMLIFrameElement) => {
    const container =
      mode === 'inline' && data.container ? doc.querySelector(data.container) : null;
    if (container) container.appendChild(f);
    else if (mode === 'inline' && script.parentNode) {
      script.parentNode.insertBefore(f, script.nextSibling);
    } else doc.body.appendChild(f);
  };

  /** "(2) Page title" while replies wait, unless the site turns it off (data-title-alert="off"). */
  let written: string | null = null;
  const showTitle = () => {
    if (data.titleAlert === 'off') return;
    // Only the count this loader wrote comes off: a title the page set since then stays whole.
    const ours = written !== null && doc.title === written;
    const base = ours ? doc.title.replace(/^\(\d+\+?\) /, '') : doc.title;
    const title = unread > 0 ? `(${unread > 9 ? '9+' : unread}) ${base}` : base;
    written = unread > 0 ? title : null;
    if (doc.title !== title) doc.title = title;
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
  /** The launcher's picture: the brand's choice, or a cross while the chat is open. */
  const drawIcon = () => {
    const chosen = ICONS[data.icon ?? config?.launcher.icon ?? ''] ?? ICONS.chat;
    drawing.setAttribute('d', open ? CLOSE : (chosen as string));
  };

  // ---------------------------------------------------------------- proactive prompts (W19)
  const store = (key: string, value?: string | null): string | null => {
    try {
      const name = `hamnivo:${widgetId}:${key}`;
      if (value === undefined) return localStorage.getItem(name);
      if (value === null) localStorage.removeItem(name);
      else localStorage.setItem(name, value);
    } catch {
      // No storage: prompts are still limited within this page view.
    }
    return null;
  };
  const recall = (): Memory | null => {
    try {
      return JSON.parse(store('proactive') ?? 'null') as Memory | null;
    } catch {
      return null;
    }
  };
  const remember = (next: Memory) => {
    memory = next;
    store('proactive', JSON.stringify(next));
  };
  let memory = visit(recall(), new Date());
  remember(memory);
  let prompt: HTMLDivElement | null = null;
  let prompted = false;
  let timers: number[] = [];

  const hidePrompt = () => {
    prompt?.remove();
    prompt = null;
  };
  const dismissPrompt = () => {
    // A reply's preview is not one of the brand's prompts: closing it changes no prompt limits.
    const reply = prompt?.hasAttribute('data-hamnivo-reply');
    hidePrompt();
    if (!reply) remember(dismissed(memory, Date.now(), config?.proactive.dismissHours ?? 24));
    button.focus();
  };
  const plain: Css = { background: 'none', border: '0', color: 'inherit', cursor: 'pointer' };
  /** The speech bubble next to the launcher; `opened` runs when the visitor chooses it. */
  const bubble = (text: string, opened: () => void): HTMLDivElement => {
    const box = make('div', {
      position: 'absolute',
      bottom: `${size + 12}px`,
      [side]: '0',
      width: 'max-content',
      'max-width': `min(300px, calc(100vw - ${2 * x}px))`,
      display: 'flex',
      gap: '4px',
      'align-items': 'flex-start',
      background: surface(),
      color: ink(),
      'border-radius': '12px',
      'box-shadow': SHADOW,
      padding: '4px',
      font: '15px/1.4 system-ui, sans-serif',
    });
    prompt = box;
    box.setAttribute('data-hamnivo-prompt', '');
    box.setAttribute('role', 'status');
    box.lang = locale ?? '';
    box.dir = 'auto';
    const message = make('button', {
      ...plain,
      font: 'inherit',
      'text-align': 'start',
      padding: '8px',
      'min-height': '44px',
    });
    message.type = 'button';
    message.textContent = text;
    on(message, 'click', () => {
      prepareSound();
      hidePrompt();
      opened();
      setOpen(true);
    });
    const close = make('button', {
      ...plain,
      font: '20px/1 system-ui, sans-serif',
      width: '44px',
      height: '44px',
      'flex-shrink': '0',
    });
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', config?.launcher.dismissLabel ?? 'Dismiss');
    on(close, 'click', dismissPrompt);
    box.append(message, close);
    shadow.appendChild(box);
    animate(box, { opacity: 0, transform: 'translateY(8px)' }, 220);
    return box;
  };
  const page = (): Page => ({
    path: location.pathname + location.search,
    referrer: doc.referrer,
    width: innerWidth,
  });
  const showPrompt = (rule: Rule) => {
    // Once per page view, never over an open chat, and within today's limit.
    if (
      prompted ||
      open ||
      out() ||
      !config ||
      !eligible(config.proactive, memory, Date.now(), page()).includes(rule)
    )
      return;
    prompted = true;
    remember(shown(memory));
    bubble(rule.message, () => send({ type: 'proactive', triggerId: rule.id }));
  };
  /** Staff invited this visitor to chat: shown like a prompt, but not counted against the limits. */
  const showInvite = (message: string) => {
    if (open || out() || !launcherMode() || prompt) return;
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
    if (!launcherMode() || open === next || (next && out())) return;
    open = next;
    hidePrompt();
    const f = ensureFrame();
    showFrame(f, next);
    fit();
    button.setAttribute('aria-expanded', String(next));
    drawIcon();
    showBadge();
    send({ type: next ? 'open' : 'close' });
    emit(next ? 'open' : 'close');
    if (next) {
      if (!calm()) {
        // Only a floating chat moves: one that fills the screen or the side appears in place.
        // A transition, not an animation: the frame's place is `!important`, which only a
        // transition may pass through.
        style(
          f,
          {
            transition: 'none',
            opacity: '0',
            transform: covered ? 'none' : 'translateY(12px) scale(.97)',
          },
          true,
        );
        // The start is drawn before the end is set.
        void f.offsetHeight;
        style(
          f,
          { transition: 'opacity .18s, transform .18s', opacity: '1', transform: 'none' },
          true,
        );
      }
      f.focus();
    } else button.focus();
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
      whenMounted(() => {
        ensureFrame();
        send({ ...message, requestId });
      });
    });

  on(window, 'message', (received) => {
    const event = received as MessageEvent;
    if (event.origin !== widgetOrigin || !frame || event.source !== frame.contentWindow) return;
    const m = event.data as Record<string, unknown> | null;
    if (m?.source !== 'hamnivo' || m.v !== 1 || m.instanceId !== instanceId) return;
    if (m.type === 'ready') {
      ready = true;
      // A frame that loaded again (the page moved it) hears where things stand before the rest.
      const pending = [
        { source: 'hamnivo', v: 1, instanceId, type: open ? 'open' : 'close' },
        ...queue,
      ];
      queue = [];
      for (const message of pending) frame.contentWindow?.postMessage(message, widgetOrigin);
      told = '';
      tell();
      placed = '';
      tellPage();
      emit('ready');
    } else if (m.type === 'layout' && m.open === false) {
      setOpen(false);
    } else if (m.type === 'resize') {
      expanded = m.size === 'expanded';
      fit();
    } else if (m.type === 'event' && typeof m.event === 'string') {
      const payload = (m.payload as Record<string, unknown>) ?? {};
      // A visitor in a conversation gets the chat loaded quietly on the next page too, so the
      // unread count follows them; nothing of the conversation is kept here, only that there is one.
      if (m.event === 'conversation.started' || m.event === 'message')
        store('live', String(Date.now()));
      if (m.event === 'conversation.resolved') store('live', null);
      if (m.event === 'unread') {
        const count = Math.max(0, Math.min(999, Math.trunc(Number(payload.count) || 0)));
        const grew = count > unread;
        unread = count;
        showBadge();
        // A new reply while the chat is closed or the tab is in the background: say so.
        if (grew) {
          animate(badge, { transform: 'scale(.4)' }, 260);
          if (payload.sound === true) chime();
          const words = typeof payload.label === 'string' ? payload.label.slice(0, 160) : '';
          if (!open && !out() && words && launcherMode()) {
            if (prompt?.hasAttribute('data-hamnivo-reply')) hidePrompt();
            if (!prompt) bubble(words, () => undefined).setAttribute('data-hamnivo-reply', '');
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

  on(doc, 'keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    if (prompt) dismissPrompt();
    else if (open) setOpen(false);
  });
  on(window.visualViewport, 'resize', fit);
  on(window.visualViewport, 'scroll', fit);
  on(window, 'resize', () => {
    here();
    fit();
  });
  // A printed page is the page, not the chat over it.
  for (const [event, during] of [
    ['beforeprint', true],
    ['afterprint', false],
  ] as const) {
    on(window, event, () => {
      printing = during;
      showRoot();
      if (frame) showFrame(frame, open);
    });
  }

  // ---------------------------------------------------------------- the page changes
  /** The website's light or dark, looked at again; the chat and the prompt follow. */
  const retheme = () => {
    const next = detect();
    if (next === scheme) return;
    scheme = next;
    if (prompt) style(prompt, { background: surface(), color: ink() });
    tell();
  };
  /** Whether the chat belongs on this page (`data-hide-on`, and phones where it is kept off). */
  const here = () => {
    const phones = data.hideOnMobile ? data.hideOnMobile === 'true' : config?.layout.hideOnMobile;
    away =
      launcherMode() &&
      (hiddenOn(data.hideOn, location.pathname) || (phones === true && innerWidth <= 480));
    if (away) {
      setOpen(false);
      hidePrompt();
    }
    showRoot();
  };
  let address = location.href;
  const watch = window.setInterval(() => {
    // A framework that replaced the page's body took the chat with it: it goes back.
    if (isMounted && doc.body) {
      if (!root.isConnected) doc.body.appendChild(root);
      if (frame && !frame.isConnected && mode !== 'inline') {
        ready = false;
        doc.body.appendChild(frame);
      }
    }
    // A single-page app sets its title after its address: both are watched.
    if (ready) tellPage();
    if (location.href === address) return;
    // A new address without a new page (a single-page app): a new page view for the prompts.
    address = location.href;
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    prompted = false;
    if (prompt && !prompt.hasAttribute('data-hamnivo-reply')) hidePrompt();
    here();
    schedulePrompts();
    retheme();
  }, 1000);

  // ---------------------------------------------------------------- start
  const mount = () => {
    const requested = data.mode as Mode | undefined;
    mode = requested && MODES.includes(requested) ? requested : (config?.layout.mode ?? 'bubble');
    side = (data.position ?? config?.layout.position) === 'bottom-left' ? 'left' : 'right';
    const within = (asked: string | undefined, set: number | undefined) => {
      const value = asked === undefined || asked === '' ? set : Number(asked);
      return value !== undefined && value >= 0 && value <= 400 ? value : 20;
    };
    x = within(data.offsetX, config?.layout.offset?.x);
    y = within(data.offsetY, config?.layout.offset?.y);
    size = SIZES[data.size ?? config?.launcher.size ?? ''] ?? 56;
    scheme = detect();
    // The page may change its theme while it is open; so may the device. An older
    // @hamnivo/react or @hamnivo/vue hides the chat with a style rule of its own, which cannot
    // reach into the launcher's shadow root: the rule being there is taken as "hide".
    const changes = new MutationObserver(() => {
      retheme();
      wrapped = doc.getElementById('hamnivo-embed-hidden') !== null;
      showRoot();
    });
    changes.observe(doc.documentElement, { attributes: true });
    changes.observe(doc.body, { attributes: true });
    changes.observe(doc.head, { childList: true });
    life.signal.addEventListener('abort', () => changes.disconnect());
    wrapped = doc.getElementById('hamnivo-embed-hidden') !== null;
    on(media('(prefers-color-scheme: dark)'), 'change', retheme);
    style(root, { all: 'initial' });
    style(
      root,
      {
        ...FIRM,
        position: 'fixed',
        top: 'auto',
        bottom: `${y}px`,
        [side === 'left' ? 'right' : 'left']: 'auto',
        [side]: `${x}px`,
        width: 'auto',
        height: 'auto',
        'max-height': 'none',
        border: '0',
        visibility: 'visible',
        'pointer-events': 'auto',
        'z-index': String(zIndex()),
      },
      true,
    );
    shadow.appendChild(edge);
    showRoot();
    doc.body.appendChild(root);
    if (!launcherMode()) {
      showFrame(ensureFrame(), true);
      open = true;
      fit();
      onMounted();
      return;
    }
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('data-hamnivo-launcher', '');
    for (const [name, value] of Object.entries({
      width: '26',
      height: '26',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    })) {
      icon.setAttribute(name, value);
    }
    style(icon, { 'flex-shrink': '0' });
    icon.appendChild(drawing);
    button.appendChild(icon);
    drawIcon();
    const launcherLabel = config?.launcher.label;
    const fontFamily = config?.launcher.fontFamily;
    button.dir = config?.dir ?? doc.documentElement.dir;
    if (fontFamily && fontFamily !== 'system') {
      const fonts = make('link');
      fonts.rel = 'stylesheet';
      fonts.href = `${widgetOrigin}/launcher-fonts.css`;
      doc.head.appendChild(fonts);
    }
    if (launcherLabel) {
      const text = make('span', {
        'max-width': 'min(180px, 45vw)',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap',
      });
      text.textContent = launcherLabel;
      text.dir = 'auto';
      text.setAttribute('data-hamnivo-launcher-label', '');
      button.appendChild(text);
    }
    style(button, {
      position: 'relative',
      width: launcherLabel ? 'auto' : `${size}px`,
      height: `${size}px`,
      padding: launcherLabel ? '0 18px' : '0',
      margin: '0',
      gap: '10px',
      font: `600 14px/1.4 ${
        fontFamily === 'dm-sans'
          ? '"Hamnivo DM Sans", "DM Sans Variable", '
          : fontFamily === 'noto-sans'
            ? '"Hamnivo Noto Sans", "Noto Sans", '
            : ''
      }system-ui, sans-serif`,
      'border-radius': `${size / 2}px`,
      border: '0',
      background: data.color ?? config?.launcher.accent ?? '#192A30',
      color: config?.launcher.onAccent ?? '#fff',
      cursor: 'pointer',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      'box-shadow': SHADOW,
      'outline-offset': '3px',
      '-webkit-tap-highlight-color': 'transparent',
      transition: calm() ? 'none' : 'transform .15s, box-shadow .15s',
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
      'box-sizing': 'border-box',
      'border-radius': '11px',
      background: '#B42318',
      color: '#fff',
      font: '700 12px/22px system-ui, sans-serif',
      display: 'none',
      'justify-content': 'center',
    });
    button.appendChild(badge);
    on(button, 'click', () => {
      prepareSound();
      setOpen(!open);
    });
    // The launcher answers the pointer, and the chat's address is looked up before the click.
    let warmed = false;
    const lift = (up: boolean) => () => {
      style(button, {
        transform: up ? 'translateY(-2px)' : 'none',
        'box-shadow': up ? '0 10px 28px rgba(0,0,0,.28)' : SHADOW,
      });
      if (!up || warmed) return;
      warmed = true;
      for (const href of new Set([widgetOrigin, api && new URL(api, location.href).origin])) {
        if (!href) continue;
        const link = make('link');
        link.rel = 'preconnect';
        link.href = href;
        doc.head.appendChild(link);
      }
    };
    on(button, 'pointerenter', lift(true));
    on(button, 'focus', lift(true));
    on(button, 'pointerleave', lift(false));
    on(button, 'blur', lift(false));
    shadow.appendChild(button);
    here();
    showBadge();
    animate(button, { opacity: 0, transform: 'scale(.6)' }, 240);
    onMounted();
    schedulePrompts();
    // In a conversation already: the chat loads when the page is idle, without opening.
    if (Number(store('live')) > Date.now() - LIVE_MS) {
      (window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1500)))(() => {
        if (!life.signal.aborted) ensureFrame();
      });
    }
  };

  // Which page the visitor is on, for the brand's staff (see visitor.ts); never with Do Not Track.
  let stopTracking: () => void = () => undefined;
  const watchVisitor = () => {
    if (!api || data.visitors === 'off') return;
    const url = `${api}/v1/widget/visits`;
    const type = 'text/plain;charset=UTF-8';
    const invited = new Set<string>();
    stopTracking = track({
      widgetId,
      page: () => ({
        url: location.href,
        title: doc.title,
        referrer: doc.referrer,
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
      visible: () => doc.visibilityState === 'visible',
      listen: (event, handler) => {
        const target = event === 'pagehide' ? window : doc;
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
    if (!api) {
      mount();
      return;
    }
    const query = new URLSearchParams({ widgetId });
    if (locale && ['en', 'ar', 'hi', 'ur'].includes(locale.slice(0, 2))) {
      query.set('locale', locale.slice(0, 2));
    }
    let started = false;
    const go = () => {
      if (started || life.signal.aborted) return;
      started = true;
      mount();
    };
    const timer = setTimeout(go, CONFIG_TIMEOUT_MS);
    fetch(`${api}/v1/widget/launcher?${query}`, { credentials: 'omit' })
      .then(async (response) => {
        if (response.ok) {
          config = (await response.json()) as LauncherConfig;
        } else {
          // The gateway says the brand does not run its chat on this website, or not at all: no
          // launcher that would open onto an error, and the owner reads why in the console. Any
          // other answer (a proxy's own page, an outage) keeps the launcher, as before.
          const problem = (await response.json().catch(() => null)) as {
            code?: string;
            detail?: string;
          } | null;
          if (problem?.code === 'ORIGIN_NOT_ALLOWED' || problem?.code === 'NOT_FOUND') {
            console.warn(`Hamnivo: ${problem.detail ?? 'the chat is not available here'}`);
            started = true;
            stopTracking();
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        go();
      });
  };
  if (doc.body) start();
  else on(doc, 'DOMContentLoaded', start);

  /** Launcher and chat out of sight, or back (launcher modes; inline and full page stay). */
  const setHidden = (next: boolean) => {
    if (!launcherMode()) return;
    hidden = next;
    if (next) {
      setOpen(false);
      hidePrompt();
    }
    showRoot();
  };

  window.Hamnivo = {
    loaded: true,
    open: () => whenMounted(() => setOpen(true)),
    close: () => setOpen(false),
    toggle: () => whenMounted(() => setOpen(!open)),
    show: () => whenMounted(() => setHidden(false)),
    hide: () => whenMounted(() => setHidden(true)),
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
      whenMounted(() => {
        ensureFrame();
        send({ type: 'prefill', text: words });
        setOpen(true);
      });
    },
    identify: (assertion) => request({ type: 'identify', assertion }),
    reset: () => {
      store('live', null);
      return request({ type: 'reset' });
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    off: (event, listener) => void listeners.get(event)?.delete(listener),
    destroy: () => {
      life.abort();
      clearInterval(watch);
      for (const timer of timers) clearTimeout(timer);
      stopTracking();
      holdPage(false);
      root.remove();
      frame?.remove();
      listeners.clear();
      delete window.Hamnivo;
    },
  };
})();
