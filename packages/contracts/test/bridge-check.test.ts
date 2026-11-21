import { describe, expect, it } from 'vitest';
import { HostToFrame, readHostToFrame } from '../src/index.js';

/** What the schema answers: the message as parsed, or null. */
const bySchema = (data: unknown) => {
  const parsed = HostToFrame.safeParse(data);
  return parsed.success ? parsed.data : null;
};
const agree = (data: unknown) =>
  expect(readHostToFrame(data), JSON.stringify(data)).toEqual(bySchema(data));

const base = { source: 'hamnivo', v: 1, instanceId: 'default' };

/** One valid message of every type, with every optional field used somewhere. */
const VALID: Record<string, unknown>[] = [
  { ...base, type: 'open' },
  { ...base, type: 'close' },
  { ...base, type: 'identify', assertion: 'x'.repeat(20), requestId: 'r1' },
  { ...base, type: 'reset', requestId: '' },
  { ...base, type: 'set-context', context: {} },
  {
    ...base,
    type: 'set-context',
    context: {
      url: 'https://shop.example/orders/1042?x=1#y',
      title: 'Order 1042',
      pageType: 'order',
      references: { orderId: '1042', a_1: '' },
    },
  },
  { ...base, type: 'send-message', text: 'Hello', requestId: 'r2' },
  { ...base, type: 'set-locale', locale: 'ar' },
  { ...base, type: 'prefill', text: 'About order #1042' },
  { ...base, type: 'proactive', triggerId: 'pricing' },
  { ...base, type: 'visitor', key: 'abcdefABCDEF0123_-' },
  { ...base, type: 'env' },
  { ...base, type: 'env', theme: 'dark', fullScreen: true, expanded: false, safeBottom: 34.5 },
];

describe('the zod-free check of messages from the host page', () => {
  it('accepts every valid message exactly as the schema does', () => {
    for (const message of VALID) {
      expect(readHostToFrame(message)).not.toBeNull();
      agree(message);
    }
  });

  it('drops keys the schema does not know, as the schema does', () => {
    agree({ ...base, type: 'open', extra: 'x' });
    agree({ ...base, type: 'set-context', context: { title: 't', script: 'alert(1)' } });
  });

  it('refuses what the schema refuses, at every boundary', () => {
    const edges: unknown[] = [
      null,
      undefined,
      'open',
      [],
      42,
      { ...base },
      { ...base, type: 'unknown' },
      { ...base, source: 'other', type: 'open' },
      { ...base, v: 2, type: 'open' },
      { ...base, v: '1', type: 'open' },
      { ...base, instanceId: 'x'.repeat(64), type: 'open' },
      { ...base, instanceId: 'x'.repeat(65), type: 'open' },
      { ...base, instanceId: 7, type: 'open' },
      { ...base, type: 'identify', assertion: 'x'.repeat(19), requestId: 'r' },
      { ...base, type: 'identify', assertion: 'x'.repeat(4096), requestId: 'r' },
      { ...base, type: 'identify', assertion: 'x'.repeat(4097), requestId: 'r' },
      { ...base, type: 'identify', assertion: 'x'.repeat(20) },
      { ...base, type: 'reset', requestId: 'r'.repeat(65) },
      { ...base, type: 'send-message', text: '', requestId: 'r' },
      { ...base, type: 'send-message', text: 't'.repeat(10_000), requestId: 'r' },
      { ...base, type: 'send-message', text: 't'.repeat(10_001), requestId: 'r' },
      { ...base, type: 'set-locale', locale: 'l'.repeat(36) },
      { ...base, type: 'prefill', text: '' },
      { ...base, type: 'prefill', text: '😊'.repeat(1000) },
      { ...base, type: 'prefill', text: '😊'.repeat(1001) },
      { ...base, type: 'proactive', triggerId: 't'.repeat(33) },
      { ...base, type: 'visitor', key: 'short' },
      { ...base, type: 'visitor', key: 'has space in it ok' },
      { ...base, type: 'visitor', key: 'k'.repeat(65) },
      { ...base, type: 'set-context' },
      { ...base, type: 'set-context', context: null },
      { ...base, type: 'set-context', context: [] },
      { ...base, type: 'set-context', context: { url: 'not a url' } },
      { ...base, type: 'set-context', context: { url: 'javascript:alert(1)' } },
      { ...base, type: 'set-context', context: { url: 'mailto:a@b.c' } },
      { ...base, type: 'set-context', context: { url: 'http://' } },
      { ...base, type: 'set-context', context: { url: `https://a.example/${'p'.repeat(1990)}` } },
      { ...base, type: 'set-context', context: { url: 42 } },
      { ...base, type: 'set-context', context: { title: 't'.repeat(301) } },
      { ...base, type: 'set-context', context: { pageType: 'p'.repeat(61) } },
      { ...base, type: 'set-context', context: { references: { '1bad': 'x' } } },
      { ...base, type: 'set-context', context: { references: { good: 'x'.repeat(201) } } },
      { ...base, type: 'set-context', context: { references: { good: 3 } } },
      { ...base, type: 'set-context', context: { references: [] } },
      { ...base, type: 'set-context', context: { references: { ['a'.repeat(42)]: 'x' } } },
      { ...base, type: 'env', theme: 'blue' },
      { ...base, type: 'env', fullScreen: 'yes' },
      { ...base, type: 'env', safeBottom: -1 },
      { ...base, type: 'env', safeBottom: 200 },
      { ...base, type: 'env', safeBottom: 200.5 },
      { ...base, type: 'env', safeBottom: Number.POSITIVE_INFINITY },
      { ...base, type: 'env', safeBottom: Number.NaN },
      { ...base, type: 'env', safeBottom: '10' },
    ];
    for (const data of edges) agree(data);
  });

  it('gives the same answer as the schema for thousands of mutated messages', () => {
    // A small seeded generator, so a failure names the same message on every run.
    let seed = 20261121;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const values: unknown[] = [
      undefined,
      null,
      '',
      'x',
      'x'.repeat(20),
      'x'.repeat(65),
      'https://a.example/',
      'not a url',
      0,
      -1,
      34,
      200,
      201,
      Number.NaN,
      true,
      false,
      {},
      [],
      'dark',
      'light',
      { url: 'https://a.example' },
      { references: { ok: 'v' } },
      { references: { '9': 'v' } },
      'abcdefABCDEF0123_-',
    ];
    for (let i = 0; i < 5000; i += 1) {
      const message: Record<string, unknown> = { ...pick(VALID) };
      const keys = [...Object.keys(message), 'extra', 'context', 'text', 'key', 'safeBottom'];
      for (let changes = 1 + Math.floor(random() * 3); changes > 0; changes -= 1) {
        const key = pick(keys);
        const value = pick(values);
        if (value === undefined && random() < 0.5) delete message[key];
        else message[key] = value;
      }
      agree(message);
    }
  });
});
