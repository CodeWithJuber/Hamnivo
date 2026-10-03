/**
 * Puts Hamnivo Chat on a page and follows it. There is no framework in this file. @hamnivo/react
 * and @hamnivo/vue each carry an identical copy of it, and a test fails if the two differ, so a
 * fix made to one is made to both. Each package adds only the glue its framework needs.
 *
 * The loader (loader.js on your chat address) starts once per page and cannot be taken apart, so
 * what this file does is load it once, follow it, and show or hide it.
 */

export type HamnivoMode = 'bubble' | 'panel' | 'inline' | 'fullpage';

export interface HamnivoLoaderOptions {
  /** The brand's widget ID, wid_…. Hamnivo Studio shows it in the install code as data-widget-id. */
  widgetId: string;
  /** Where Hamnivo Chat runs, for example https://chat.example.com. Only its origin is used. */
  chatUrl: string;
  /** The Hamnivo API of the same installation, for example https://api.example.com (data-api). */
  apiUrl?: string;
  /** en, ar, hi or ur. Without it the page's lang attribute decides. */
  locale?: string;
  /** Replaces the layout the brand chose in Studio. */
  mode?: HamnivoMode;
  position?: 'bottom-right' | 'bottom-left';
  /** The launcher's background, as any CSS colour. */
  color?: string;
  /** For the inline mode: a CSS selector for the element the chat goes in. */
  container?: string;
  /** For the inline mode: the height of the chat, for example 600px. */
  height?: string;
  /** Accessible names. Without them the brand's own labels are used. */
  labels?: { open?: string; close?: string; title?: string };
  /** The nonce of your Content-Security-Policy, if it needs one for scripts and styles. */
  nonce?: string;
}

/** What the loader puts on window.Hamnivo. */
export interface HamnivoApi {
  loaded: true;
  open(): void;
  close(): void;
  toggle(): void;
  /** Tells the chat who the visitor is, with an assertion your server signed. */
  identify(assertion: string): Promise<void>;
  /** Signs the visitor out of the chat, on this device and in Hamnivo. */
  reset(): Promise<void>;
  on(event: string, listener: (payload: Record<string, unknown>) => void): () => void;
}

/** The signed-in customer, as your page knows them. */
export interface HamnivoCustomer {
  /** Your stable id for the account. A change of key is a change of customer. */
  key: string;
  /** Asks your server for a fresh, short-lived assertion for this customer. */
  getAssertion: () => Promise<string>;
}

export interface HamnivoState {
  /** The loader has started, so the controls work. */
  loaded: boolean;
  /** The chat window is open. Only the bubble and panel layouts open and close. */
  isOpen: boolean;
  /** Replies that wait while the chat is closed. */
  unread: number;
  /** This page told the chat who the visitor is, and the chat accepted it. */
  verified: boolean;
}

export interface HamnivoControls {
  open(): void;
  close(): void;
  toggle(): void;
  identify(assertion: string): Promise<void>;
  reset(): Promise<void>;
}

const NOT_LOADED = 'Hamnivo Chat is not on this page yet. Render <HamnivoChat /> first.';

const currentApi = (): HamnivoApi | null => {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { Hamnivo?: HamnivoApi }).Hamnivo;
  return api?.loaded ? api : null;
};

// ------------------------------------------------------------------------ state of the chat

export const INITIAL_STATE: HamnivoState = {
  loaded: false,
  isOpen: false,
  unread: 0,
  verified: false,
};

let state = INITIAL_STATE;
const listeners = new Set<() => void>();
let attached: HamnivoApi | null = null;

function publish(patch: Partial<HamnivoState>): void {
  const next = { ...state, ...patch };
  if (
    next.loaded === state.loaded &&
    next.isOpen === state.isOpen &&
    next.unread === state.unread &&
    next.verified === state.verified
  ) {
    return;
  }
  state = next;
  for (const listener of [...listeners]) listener();
}

function attach(api: HamnivoApi): void {
  if (attached === api) return;
  attached = api;
  api.on('open', () => publish({ isOpen: true }));
  api.on('close', () => publish({ isOpen: false }));
  api.on('unread', (payload) => {
    const count = Math.trunc(Number(payload.count));
    publish({ unread: Number.isFinite(count) && count > 0 ? count : 0 });
  });
  api.on('identity.changed', (payload) => publish({ verified: payload.verified === true }));
  publish({ loaded: true });
}

/** The state now. The same object until something changes, as a store snapshot must be. */
export function getHamnivoState(): HamnivoState {
  return state;
}

/** Calls the listener when the state changes. It also picks up a loader that started elsewhere. */
export function subscribeHamnivo(listener: () => void): () => void {
  listeners.add(listener);
  const api = currentApi();
  if (api) attach(api);
  return () => {
    listeners.delete(listener);
  };
}

// ------------------------------------------------------------------------ the controls

/** Waits for the loader if it is on its way, and says so if nothing is loading it. */
export function whenHamnivoLoaded(): Promise<HamnivoApi> {
  const api = currentApi();
  if (api) return Promise.resolve(api);
  return pending ?? Promise.reject(new Error(NOT_LOADED));
}

export const hamnivoControls: HamnivoControls = {
  open: () => currentApi()?.open(),
  close: () => currentApi()?.close(),
  toggle: () => currentApi()?.toggle(),
  identify: (assertion) => whenHamnivoLoaded().then((api) => api.identify(assertion)),
  reset: () => whenHamnivoLoaded().then((api) => api.reset()),
};

// ------------------------------------------------------------------------ loading the loader

let pending: Promise<HamnivoApi> | null = null;
let loadedWith: { widgetId: string; chatOrigin: string } | null = null;

function webAddress(text: string, name: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    // Fall through to the message below.
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error(`Hamnivo Chat: ${name} must be a web address like https://chat.example.com.`);
  }
  return url;
}

function warnIfDifferent(options: HamnivoLoaderOptions): void {
  if (!loadedWith) return;
  const chatOrigin = webAddress(options.chatUrl, 'chatUrl').origin;
  if (loadedWith.widgetId !== options.widgetId || loadedWith.chatOrigin !== chatOrigin) {
    console.warn(
      `Hamnivo Chat is already on this page for ${loadedWith.widgetId} at ${loadedWith.chatOrigin}. ` +
        'The loader starts once per page, so the settings you gave now are ignored.',
    );
  }
}

/**
 * Adds the loader script to the page, once. It resolves with window.Hamnivo when the loader has
 * started, at once if it already has, and rejects if the script cannot load or does not start.
 * Called again while it loads, or after, it returns the same chat, so it is safe to call from
 * every component that wants the chat.
 */
export function loadHamnivo(options: HamnivoLoaderOptions): Promise<HamnivoApi> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Hamnivo Chat loads in a browser, not on the server.'));
  }
  if (!options.widgetId || typeof options.widgetId !== 'string') {
    return Promise.reject(new Error('Hamnivo Chat: widgetId is required.'));
  }
  const existing = currentApi();
  if (existing) {
    warnIfDifferent(options);
    attach(existing);
    return Promise.resolve(existing);
  }
  if (pending) {
    warnIfDifferent(options);
    return pending;
  }

  let chatOrigin: string;
  let apiAddress = '';
  try {
    chatOrigin = webAddress(options.chatUrl, 'chatUrl').origin;
    if (options.apiUrl) {
      const api = webAddress(options.apiUrl, 'apiUrl');
      apiAddress = (api.origin + api.pathname).replace(/\/+$/, '');
    }
  } catch (error) {
    return Promise.reject(error);
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = `${chatOrigin}/loader.js`;
  const data = script.dataset;
  data.widgetId = options.widgetId;
  if (apiAddress) data.api = apiAddress;
  if (options.locale) data.locale = options.locale;
  if (options.mode) data.mode = options.mode;
  if (options.position) data.position = options.position;
  if (options.color) data.color = options.color;
  if (options.container) data.container = options.container;
  if (options.height) data.height = options.height;
  if (options.labels?.open) data.label = options.labels.open;
  if (options.labels?.close) data.closeLabel = options.labels.close;
  if (options.labels?.title) data.title = options.labels.title;
  if (options.nonce) script.nonce = options.nonce;

  loadedWith = { widgetId: options.widgetId, chatOrigin };
  const started = new Promise<HamnivoApi>((resolve, reject) => {
    const fail = (message: string) => {
      pending = null;
      loadedWith = null;
      script.remove();
      reject(new Error(message));
    };
    script.addEventListener('load', () => {
      const api = currentApi();
      if (!api) {
        fail('The Hamnivo loader ran but did not start. Check the widget ID.');
        return;
      }
      pending = null;
      attach(api);
      resolve(api);
    });
    script.addEventListener('error', () => {
      fail(`The Hamnivo loader could not be loaded from ${script.src}. Check the chat address.`);
    });
  });
  pending = started;
  nonce = options.nonce;
  document.body.appendChild(script);
  return started;
}

// ------------------------------------------------------------------------ show and hide

const HIDDEN_STYLE = 'hamnivo-embed-hidden';
let nonce: string | undefined;
let mounted = 0;

function setHidden(hidden: boolean): void {
  if (typeof document === 'undefined') return;
  const style = document.getElementById(HIDDEN_STYLE);
  if (!hidden) {
    style?.remove();
    return;
  }
  if (style) return;
  currentApi()?.close();
  const element = document.createElement('style');
  element.id = HIDDEN_STYLE;
  if (nonce) element.nonce = nonce;
  element.textContent =
    '[data-hamnivo-launcher],[data-hamnivo-frame],[data-hamnivo-prompt]{display:none!important}';
  document.head.appendChild(element);
}

/**
 * Says that a component wants the chat on screen, and returns the function that says it does not.
 * The loader cannot be taken apart, so when the last component is gone the chat is hidden, and it
 * comes back when the next one arrives.
 */
export function mountHamnivo(): () => void {
  mounted += 1;
  setHidden(false);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mounted -= 1;
    if (mounted === 0) setHidden(true);
  };
}

// ------------------------------------------------------------------------ who is signed in

const verifiedKey = (widgetId: string) => `hamnivo:embed:verified:${widgetId}`;

function remember(widgetId: string, verified: boolean): void {
  try {
    if (verified) window.localStorage.setItem(verifiedKey(widgetId), '1');
    else window.localStorage.removeItem(verifiedKey(widgetId));
  } catch {
    // No storage, for example in a private window: the next page does the same work again.
  }
}

function wasVerified(widgetId: string): boolean {
  try {
    return window.localStorage.getItem(verifiedKey(widgetId)) === '1';
  } catch {
    return false;
  }
}

let queue: Promise<void> = Promise.resolve();
let latest = 0;

/**
 * Makes the chat match who is signed in. `read` gives the signed-in customer as the page knows
 * them when the call gets to run, so the latest getAssertion is the one that is called. With a
 * customer, it asks for a fresh assertion and identifies. Without one, it signs the chat out if
 * this browser was verified before, so the next person on a shared computer starts anonymous, also
 * after a reload. Calls run one after another, so a sign-out never overtakes the sign-in before
 * it. A call that a newer one has replaced, and that has not asked anything yet, does nothing.
 * A failure to get the assertion, or the chat refusing it, rejects. A chat that cannot load does
 * not: the component that loads it reports that.
 */
export function syncHamnivoCustomer(
  options: HamnivoLoaderOptions,
  read: () => HamnivoCustomer | null,
): Promise<void> {
  latest += 1;
  const mine = latest;
  const run = async () => {
    if (mine !== latest) return;
    // A chat that did not load is reported by whoever put it on the page, so it is not reported
    // here a second time.
    const api = await loadHamnivo(options).catch(() => undefined);
    // The chat can take a while to load, and a newer call may have come in the meantime.
    if (!api || mine !== latest) return;
    const customer = read();
    if (customer) {
      const assertion = await customer.getAssertion();
      await api.identify(assertion);
      remember(options.widgetId, true);
    } else if (wasVerified(options.widgetId)) {
      try {
        await api.reset();
      } finally {
        // The flag goes even when the chat could not be reached: the browser is signed out.
        remember(options.widgetId, false);
      }
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
