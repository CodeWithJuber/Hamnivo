import { createFileRoute } from '@tanstack/react-router';
import {
  CHANNELS,
  type ChannelFilter,
  type InboxQueue,
  type InboxSearch,
  QUEUES,
  STATUSES,
  type StatusFilter,
} from '../../lib/inbox';
import { InboxPage } from '../../pages/inbox/InboxPage';

const text = (value: unknown, max = 200) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export const Route = createFileRoute('/_studio/inbox')({
  validateSearch: (search: Record<string, unknown>): InboxSearch => {
    const result: InboxSearch = {};
    const queue = oneOf<InboxQueue>(QUEUES, search.queue);
    const status = oneOf<StatusFilter>(STATUSES, search.status);
    const channel = oneOf<ChannelFilter>(CHANNELS, search.channel);
    if (queue) result.queue = queue;
    if (status) result.status = status;
    if (channel) result.channel = channel;
    const brand = text(search.brand, 64);
    const language = text(search.language, 35);
    const tag = text(search.tag, 255);
    const q = text(search.q);
    if (brand) result.brand = brand;
    if (language) result.language = language;
    if (tag) result.tag = tag;
    if (q) result.q = q;
    return result;
  },
  component: InboxPage,
});
