/**
 * Which page a visitor is on, for the brand's staff (live visitors and the visitor card). The
 * loader reports a page view, "still here" every 20 seconds while the page shows, and "left" when
 * it closes. It reports nothing for a browser that sends Do Not Track or Global Privacy Control, or
 * when the website's script says `data-visitors="off"`, and it stops for the page as soon as the
 * brand turns tracking off. The key is random, kept on this device for this website only, and the
 * gateway stores only a hash of it.
 */

export interface Invite {
  id: string;
  message: string;
}

export interface Ack {
  tracking: boolean;
  invite: Invite | null;
}

export interface Env {
  widgetId: string;
  /** The page as it is now (address, title, where the visitor came from, language). */
  page(): { url: string; title: string; referrer: string; language: string };
  /** The browser asks not to be tracked. */
  optOut(): boolean;
  visible(): boolean;
  /** Calls `handler` when the tab is shown or hidden, or the page is closing; returns the undo. */
  listen(event: 'visibilitychange' | 'pagehide', handler: () => void): () => void;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  random(bytes: number): Uint8Array;
  /** Sends one report; resolves to the gateway's answer, or null when there is none. */
  post(body: string): Promise<Ack | null>;
  /** Sends the "left" report in a way that survives the page closing. */
  beacon(body: string): void;
  /** Tracking is on: the chat gets the key, so staff see the pages next to its conversation. */
  onTracking(key: string): void;
  /** Staff invited this visitor to chat. */
  onInvite(invite: Invite): void;
}

/** "Still here" is reported this often while the page is shown. */
export const BEAT_MS = 20_000;
/** The address is looked at this often, so a page change without a reload is seen at once. */
export const WATCH_MS = 2000;

/** A new random key: 22 URL-safe characters. */
export function newKey(random: (bytes: number) => Uint8Array): string {
  let text = '';
  for (const byte of random(16)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const KEY_FORMAT = /^[A-Za-z0-9_-]{16,64}$/;

/** The key kept on this device for this website, made on the first visit. */
export function keyFor(env: Pick<Env, 'widgetId' | 'storage' | 'random'>): string {
  const name = `hamnivo:${env.widgetId}:visitor`;
  try {
    const kept = env.storage.getItem(name);
    if (kept && KEY_FORMAT.test(kept)) return kept;
    const made = newKey(env.random);
    env.storage.setItem(name, made);
    return made;
  } catch {
    // No storage (private mode): this page view is a visitor of its own.
    return newKey(env.random);
  }
}

/** Starts reporting; returns the call that stops it. */
export function track(env: Env): () => void {
  if (env.optOut()) return () => undefined;
  const key = keyFor(env);
  let shown = '';
  let sentAt = 0;
  let stopped = false;
  let told = false;
  let invited = '';

  const body = (event: 'view' | 'beat' | 'leave') => {
    const page = env.page();
    return JSON.stringify({
      widgetId: env.widgetId,
      key,
      event,
      url: page.url,
      title: page.title.slice(0, 300),
      ...(page.referrer ? { referrer: page.referrer } : {}),
      ...(page.language ? { language: page.language } : {}),
    });
  };
  const send = (event: 'view' | 'beat') => {
    shown = env.page().url;
    sentAt = Date.now();
    void env
      .post(body(event))
      .then((ack) => {
        if (!ack || stopped) return;
        // The brand turned tracking off: nothing more from this page.
        if (!ack.tracking) return stop();
        if (!told) {
          told = true;
          env.onTracking(key);
        }
        // Each invitation is shown once, however many reports carry it.
        if (ack.invite && ack.invite.id !== invited) {
          invited = ack.invite.id;
          env.onInvite(ack.invite);
        }
      })
      .catch(() => undefined);
  };
  const watch = () => {
    if (stopped || !env.visible()) return;
    const now = env.page().url;
    if (now !== shown) send('view');
    else if (Date.now() - sentAt >= BEAT_MS) send('beat');
  };
  const timer = setInterval(watch, WATCH_MS);
  const undo = [
    env.listen('visibilitychange', () => {
      if (env.visible()) watch();
    }),
    env.listen('pagehide', () => {
      if (!stopped && told) env.beacon(body('leave'));
    }),
  ];
  function stop() {
    stopped = true;
    clearInterval(timer);
    for (const off of undo) off();
  }
  if (env.visible()) send('view');
  return stop;
}
