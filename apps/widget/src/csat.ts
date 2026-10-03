import type { HamnivoClient, KeyValueStorage } from '@hamnivo/client';

/**
 * The rating a customer may give when a chat is closed (CSAT, W03). Whether it is asked is the
 * brand's choice. The gateway keeps one rating per customer and conversation, so asking once per
 * device is only politeness: a rating already given is remembered here and not asked for again.
 */

export const ratedKey = (widgetId: string, conversationId: string) =>
  `hamnivo:${widgetId}:rated:${conversationId}`;

/** The rating this device already sent for a conversation, if any. */
export function readRated(storage: KeyValueStorage, key: string): number | null {
  try {
    const value = Number(storage.getItem(key));
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
  } catch {
    return null;
  }
}

/** Sends the rating (and a comment, when there is one), then remembers it on this device. */
export async function sendRating(
  client: HamnivoClient,
  conversationId: string,
  rating: number,
  comment: string,
): Promise<void> {
  const note = comment.trim();
  await client.request(
    'POST',
    `/v1/widget/conversations/${encodeURIComponent(conversationId)}/feedback`,
    { rating, ...(note ? { comment: note } : {}) },
  );
  try {
    client.storage.setItem(ratedKey(client.options.widgetId, conversationId), String(rating));
  } catch {
    // Not remembered on this device: the rating was still sent.
  }
}
