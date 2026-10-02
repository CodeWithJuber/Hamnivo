import type { HamnivoClient } from '@hamnivo/client';
import type { ReplyLanguage, WidgetLanguageState } from '@hamnivo/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { Locale } from './i18n.js';

/**
 * The customer's reply language (U01, HNV-07-04). Read again after each reply from the assistant,
 * since a reply is when the server may start asking which of two languages the customer writes
 * (Hinglish or Roman Urdu). Choosing or closing the question is saved on the server, so it is
 * not asked again on another page or device.
 */
export function useReplyLanguage(client: HamnivoClient, person: string | null, replies: number) {
  const [state, setState] = useState<WidgetLanguageState | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after each new reply
  useEffect(() => {
    if (!person) {
      setState(null);
      return;
    }
    let cancelled = false;
    client
      .language()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, person, replies]);

  const choose = useCallback(
    async (language: ReplyLanguage) =>
      setState(await client.setLanguage({ replyLanguage: language })),
    [client],
  );
  const dismiss = useCallback(
    async () => setState(await client.setLanguage({ dismissPrompt: true })),
    [client],
  );
  /** The interface language is one input to the reply language; saving it never fails the chat. */
  const saveLocale = useCallback(
    async (uiLocale: Locale) => {
      if (!person) return;
      try {
        setState(await client.setLanguage({ uiLocale }));
      } catch {
        // Kept on this device only; replies still follow the customer's messages.
      }
    },
    [client, person],
  );
  return { state, choose, dismiss, saveLocale };
}
