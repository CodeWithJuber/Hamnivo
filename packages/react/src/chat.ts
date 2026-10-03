import { useEffect, useRef } from 'react';
import {
  type HamnivoApi,
  type HamnivoCustomer,
  type HamnivoLoaderOptions,
  loadHamnivo,
  mountHamnivo,
  syncHamnivoCustomer,
} from './embed.js';

export interface HamnivoChatProps extends HamnivoLoaderOptions {
  /**
   * The signed-in customer, or null or nothing for a visitor who is signed out. With a customer,
   * the chat asks `getAssertion` for a fresh assertion and identifies them, so they see their own
   * conversations on any device. When the key changes the chat identifies the new customer, and
   * when it goes to null the chat is signed out. Keep `key` stable: it is how a change is noticed.
   */
  customer?: HamnivoCustomer | null;
  /** Called once the loader has started. */
  onReady?: (api: HamnivoApi) => void;
  /** Called when the loader cannot start, or when telling the chat who is signed in fails. */
  onError?: (error: Error) => void;
}

/**
 * Puts Hamnivo Chat on the page and renders nothing itself. Render it once, high in the tree. The
 * loader starts once per page, so the settings are read when the chat first appears and later
 * changes to them are ignored. When the last HamnivoChat unmounts the chat is hidden, and it comes
 * back when one mounts again.
 */
export function HamnivoChat(props: HamnivoChatProps): null {
  const { customer, onReady, onError, ...options } = props;
  const latest = useRef({ options, customer, onReady, onError });
  // Runs before the effects below, which read it.
  useEffect(() => {
    latest.current = { options, customer, onReady, onError };
  });

  useEffect(() => {
    let cancelled = false;
    const unmount = mountHamnivo();
    loadHamnivo(latest.current.options).then(
      (api) => {
        if (!cancelled) latest.current.onReady?.(api);
      },
      (error: Error) => {
        if (!cancelled) report(latest.current.onError, error);
      },
    );
    return () => {
      cancelled = true;
      unmount();
    };
  }, []);

  // A change of customer is a change of key. The latest getAssertion is the one that is called.
  const key = customer?.key ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new key means a new customer
  useEffect(() => {
    let cancelled = false;
    syncHamnivoCustomer(latest.current.options, () => latest.current.customer ?? null).catch(
      (error: Error) => {
        if (!cancelled) report(latest.current.onError, error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  return null;
}

function report(handler: ((error: Error) => void) | undefined, error: Error): void {
  if (handler) handler(error);
  else console.error(error.message);
}
