import type { HamnivoClient } from '@hamnivo/client';
import type { VisitorInvite } from '@hamnivo/contracts';
import { useCallback, useEffect, useState } from 'react';

export interface VisitorState {
  /** The line that says the website notes which pages are viewed; null when it does not. */
  notice: string | null;
  /** A message staff left for this visitor, shown as the chat's greeting. */
  invite: VisitorInvite | null;
}

const NONE: VisitorState = { notice: null, invite: null };

/**
 * The browser's key from the loader (it sends one only while the brand tracks pages and the
 * browser sends no Do Not Track or Global Privacy Control signal). The chat tells the gateway which
 * browser it runs in, so staff see the pages next to the conversation, and keeps the answer: the
 * line to show the visitor, and an invitation if staff left one. When the person changes (the
 * website signs a customer in or out) the new person is linked to the same browser.
 */
export function useVisitor(
  client: HamnivoClient,
  principalId: string | null,
  locale: string,
): { state: VisitorState; setKey: (key: string) => void } {
  const [key, setKey] = useState<string | null>(null);
  const [state, setState] = useState<VisitorState>(NONE);
  const keep = useCallback((next: string) => setKey(next), []);

  useEffect(() => {
    if (!key || !principalId) return;
    let current = true;
    client
      .linkVisitor(key, locale)
      .then((linked) => {
        if (!current) return;
        // A later link finds no invitation (it was taken), so the greeting is kept until the page closes.
        setState((before) => ({
          notice: linked.notice,
          invite: linked.invite ?? (linked.tracking ? before.invite : null),
        }));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, key, principalId, locale]);

  return { state, setKey: keep };
}
