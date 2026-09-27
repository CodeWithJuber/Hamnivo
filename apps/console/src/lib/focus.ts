import { useLayoutEffect, useRef } from 'react';

/**
 * Remembers what had focus when `open` turned true. Runs before Radix moves focus into a dialog
 * (Radix does that in a normal effect).
 */
export function useOpener(open: boolean) {
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement;
  }, [open]);
  return opener;
}

/**
 * Puts focus back after a dialog or sheet closes. Radix only returns focus to its own trigger
 * element, and Studio opens dialogs from state, so this is done by hand: the opener if it is
 * still on the page, else the fallback, else the page heading.
 */
export function returnFocus(opener: Element | null, fallback?: () => HTMLElement | null) {
  const target =
    opener instanceof HTMLElement && opener.isConnected && opener !== document.body
      ? opener
      : (fallback?.() ?? document.getElementById('page-title'));
  target?.focus();
}
