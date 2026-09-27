import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CARD_KINDS,
  Card,
  FrameToHost,
  HostToFrame,
  isTypeId,
  MinorUnits,
  Money,
  parseEvent,
  parsePart,
  parseParts,
  partsToPlainText,
  problem,
  SendMessageRequest,
  TRANSIENT_EVENT_TYPES,
  TYPEID_SUFFIX,
  WidgetConfig,
} from '../src/index.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/v1', name), 'utf8'));

describe('identifiers', () => {
  it('accepts TypeIDs with the right prefix only', () => {
    expect(isTypeId('conv_01j9zk7w3xq8r4t2v6m5n1p0ce', 'conv')).toBe(true);
    expect(isTypeId('msg_01j9zk7w3xq8r4t2v6m5n1p0ce', 'conv')).toBe(false);
    expect(isTypeId('conv_81j9zk7w3xq8r4t2v6m5n1p0ce', 'conv')).toBe(false); // > 128 bits
    expect(isTypeId('conv_01j9zk7w3xq8r4t2v6m5n1p0cu', 'conv')).toBe(false); // 'u' excluded
    expect(isTypeId(42, 'conv')).toBe(false);
    expect(TYPEID_SUFFIX.test('01j9zk7w3xq8r4t2v6m5n1p0c')).toBe(false); // 25 chars
  });
});

describe('money', () => {
  it('keeps amounts as exact integer strings in minor units', () => {
    expect(MinorUnits.safeParse('14900').success).toBe(true);
    expect(MinorUnits.safeParse('-500').success).toBe(true);
    expect(MinorUnits.safeParse('149.00').success).toBe(false);
    expect(MinorUnits.safeParse('00100').success).toBe(false);
    expect(Money.safeParse({ amountMinor: '100', currency: 'aed' }).success).toBe(false);
  });
});

describe('message parts', () => {
  it('parses known parts and defaults text format to plain', () => {
    expect(parsePart({ type: 'text', text: 'Hello' })).toEqual({
      type: 'text',
      text: 'Hello',
      format: 'plain',
    });
  });

  it('turns unknown future part types into a safe fallback', () => {
    expect(parsePart({ type: 'poll', question: 'Q?', fallbackText: 'Poll: Q?' })).toEqual({
      type: 'unknown',
      originalType: 'poll',
      fallbackText: 'Poll: Q?',
    });
  });

  it('treats an invalid known part as unknown instead of throwing', () => {
    const part = parsePart({ type: 'attachment', name: 'x.pdf' });
    expect(part.type).toBe('unknown');
    expect(parseParts('not-an-array')).toEqual([]);
  });

  it('renders plain text for previews and text-only channels', () => {
    const text = partsToPlainText([
      { type: 'text', text: 'Your order', format: 'plain' },
      { type: 'unknown', originalType: 'poll', fallbackText: null },
      {
        type: 'source',
        sourceId: 's',
        title: 'Returns policy',
        url: 'https://example.com/returns',
        version: null,
        excerpt: null,
        freshness: 'current',
      },
    ]);
    expect(text).toBe('Your order\nReturns policy (https://example.com/returns)');
  });

  it('limits a send to text and uploaded-attachment references', () => {
    const ok = SendMessageRequest.safeParse({
      clientMessageId: '8f14e45f-ceea-467a-9a3e-2d2f0b5c4a11',
      parts: [
        { type: 'text', text: 'Hi' },
        { type: 'attachment', uploadId: 'upl_01j9zk7w3xq8r4t2v6m5n1p0ce' },
      ],
    });
    expect(ok.success).toBe(true);
    const cardFromClient = SendMessageRequest.safeParse({
      clientMessageId: '8f14e45f-ceea-467a-9a3e-2d2f0b5c4a11',
      parts: [{ type: 'card', fallbackText: 'x', card: {} }],
    });
    expect(cardFromClient.success).toBe(false);
  });
});

describe('cards', () => {
  it('registers every card kind in the union', () => {
    for (const kind of CARD_KINDS) {
      expect(Card.options.some((option) => option.shape.kind.value === kind)).toBe(true);
    }
  });

  it('keeps catalog prices as exact minor units and degrades an unknown card to its text', () => {
    const item = {
      productId: 'prod_pens',
      variantId: null,
      name: 'Black Pen Set',
      description: null,
      unitPriceMinor: '1500',
      currency: 'AED',
      availability: 'unknown',
      stockQuantity: null,
      imageUrl: null,
    };
    const card = {
      kind: 'catalog',
      version: 1,
      snapshotId: 'cat_x',
      merchant: { id: 'mrc_x', name: 'Northline Store' },
      items: [item],
      observedAt: '2026-09-27T10:21:00Z',
      source: 'mock:catalog',
    };
    expect(Card.safeParse(card).success).toBe(true);
    expect(Card.safeParse({ ...card, items: [{ ...item, unitPriceMinor: '15.00' }] }).success).toBe(
      false,
    );
    expect(
      parsePart({
        type: 'card',
        card: { ...card, kind: 'subscription_offer' },
        fallbackText: 'Offer',
      }),
    ).toEqual({ type: 'unknown', originalType: 'card', fallbackText: 'Offer' });
  });
});

describe('event envelope (forward compatibility, E04)', () => {
  for (const file of readdirSync(join(import.meta.dirname, '../fixtures/v1'))) {
    it(`parses fixture ${file} without throwing`, () => {
      const parsed = parseEvent(fixture(file));
      expect(parsed.kind).not.toBe('invalid');
    });
  }

  it('accepts newer minor versions with extra fields', () => {
    const parsed = parseEvent(fixture('future-minor-version.json'));
    expect(parsed.kind).toBe('event');
    if (parsed.kind === 'event') expect(parsed.event.type).toBe('handoff.requested');
  });

  it('surfaces unknown event types so clients can ignore them', () => {
    expect(parseEvent(fixture('unknown-event-type.json'))).toEqual({
      kind: 'unknown',
      type: 'reaction.added',
      sequence: 45,
    });
  });

  it('reports malformed known events as invalid', () => {
    const parsed = parseEvent({ ...fixture('message-created.json'), sequence: -1 });
    expect(parsed.kind).toBe('invalid');
  });

  it('marks streaming deltas and typing as transient', () => {
    expect(TRANSIENT_EVENT_TYPES.has('message.delta')).toBe(true);
    expect(TRANSIENT_EVENT_TYPES.has('message.created')).toBe(false);
  });
});

describe('problem details', () => {
  it('fills status, retry guidance and a stable type URI', () => {
    const p = problem('RATE_LIMITED', 'req_1', { retryAfter: 30 });
    expect(p).toMatchObject({ status: 429, retryable: true, code: 'RATE_LIMITED', retryAfter: 30 });
    expect(p.type).toBe('https://hamnivo.dev/problems/rate-limited');
    expect(problem('ACTION_OUTCOME_UNKNOWN', 'req_2').retryable).toBe(false);
  });
});

describe('widget bridge', () => {
  const base = { source: 'hamnivo', v: 1, instanceId: 'default' } as const;
  it('accepts only known messages from the hamnivo source at version 1', () => {
    expect(HostToFrame.safeParse({ ...base, type: 'open' }).success).toBe(true);
    expect(HostToFrame.safeParse({ ...base, source: 'evil', type: 'open' }).success).toBe(false);
    expect(HostToFrame.safeParse({ ...base, v: 2, type: 'open' }).success).toBe(false);
    expect(HostToFrame.safeParse({ ...base, type: 'eval', code: 'alert(1)' }).success).toBe(false);
  });
  it('limits frame events to scalar payload values', () => {
    expect(
      FrameToHost.safeParse({ ...base, type: 'event', event: 'unread', payload: { count: 2 } })
        .success,
    ).toBe(true);
    expect(
      FrameToHost.safeParse({
        ...base,
        type: 'event',
        event: 'unread',
        payload: { nested: { a: 1 } },
      }).success,
    ).toBe(false);
  });
});

describe('widget config', () => {
  it('requires hex colours for tenant branding', () => {
    const result = WidgetConfig.shape.brand.safeParse({
      name: 'Acme',
      logoUrl: null,
      accent: 'red',
      onAccent: '#FFFFFF',
      radius: 12,
      launcherPosition: 'bottom-right',
    });
    expect(result.success).toBe(false);
  });
});
