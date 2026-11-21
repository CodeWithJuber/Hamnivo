import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SentAt } from '../src/components/thread/Delivery.js';

describe('the time under a message', () => {
  const at = '2026-11-21T09:05:00Z';

  it('shows at the end of a sender’s turn', () => {
    const html = renderToString(<SentAt at={at} locale="en" />);
    expect(html).toContain('dateTime="2026-11-21T09:05:00.000Z"');
    expect(html).not.toContain('sr-only');
  });

  it('is read out but not shown inside a turn, until hovered, focused or tapped', () => {
    const html = renderToString(<SentAt at={at} locale="en" quiet />);
    expect(html).toContain('dateTime="2026-11-21T09:05:00.000Z"');
    expect(html).toContain('sr-only');
    for (const reveal of [
      'group-hover/message:not-sr-only',
      'group-focus-within/message:not-sr-only',
      'group-data-[show-time]/message:not-sr-only',
    ])
      expect(html).toContain(reveal);
  });

  it('says nothing for a message without a time', () => {
    expect(renderToString(<SentAt at={undefined} locale="en" quiet />)).toBe('');
  });
});
