import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  canonicalJson,
  QuoteArithmeticError,
  type QuoteDocument,
  quoteHash,
  sha256Hex,
  UnknownCurrencyError,
  verifyQuoteArithmetic,
} from '../../src/commerce/index.js';

/** The seeded demo order from board 20: notebook, pen set and delivery, AED 60. */
function demoQuote(overrides: Partial<QuoteDocument> = {}): QuoteDocument {
  return {
    v: 1,
    quoteId: 'quo_01j9zk7w3xq8r4t2v6m5n1p0cm',
    merchant: { connectionId: 'mrc_01j9zk7w3xq8r4t2v6m5n1p0aa', name: 'Northline Store' },
    cart: { id: 'cart_01j9zk7w3xq8r4t2v6m5n1p0bb', revision: 3 },
    currency: 'AED',
    lines: [
      {
        lineId: 'l1',
        productId: 'prod_notebook',
        variantId: null,
        name: 'Everyday Notebook',
        quantity: 1,
        unitPriceMinor: '3500',
        totalMinor: '3500',
      },
      {
        lineId: 'l2',
        productId: 'prod_pens',
        variantId: 'black',
        name: 'Black Pen Set',
        quantity: 1,
        unitPriceMinor: '1500',
        totalMinor: '1500',
      },
    ],
    subtotalMinor: '5000',
    discountMinor: '0',
    taxMinor: null,
    taxMode: 'included',
    shippingMinor: '1000',
    totalMinor: '6000',
    recurring: null,
    delivery: 'Sara N. · Al Noor Street, Dubai',
    expiresAt: '2026-09-27T21:00:00.000Z',
    ...overrides,
  };
}

describe('canonical hashing', () => {
  it('matches the SHA-256 test vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('ignores key order and turns bigints and dates into strings', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3n, c: new Date(0) }] })).toBe(
      '{"a":[2,{"c":"1970-01-01T00:00:00.000Z","d":"3"}],"b":1}',
    );
    expect(canonicalHash({ x: 1, y: 2 })).toBe(canonicalHash({ y: 2, x: 1 }));
    expect(canonicalJson({ kept: null, dropped: undefined })).toBe('{"kept":null}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
  });
});

describe('quote document', () => {
  it('adds up exactly for the demo order', () => {
    expect(() => verifyQuoteArithmetic(demoQuote())).not.toThrow();
    expect(quoteHash(demoQuote())).toMatch(/^[a-f0-9]{64}$/);
    expect(quoteHash(demoQuote())).toBe(quoteHash(JSON.parse(JSON.stringify(demoQuote()))));
  });

  it('changes its hash when anything the customer approves changes', () => {
    const base = quoteHash(demoQuote());
    const [notebook, pens] = demoQuote().lines as [
      QuoteDocument['lines'][number],
      QuoteDocument['lines'][number],
    ];
    const variants: Partial<QuoteDocument>[] = [
      { totalMinor: '6001' },
      { currency: 'USD' },
      { shippingMinor: '1100' },
      { discountMinor: '100' },
      { taxMinor: '0' },
      { recurring: { interval: 'month', intervalCount: 1 } },
      { delivery: 'Sara N. · Marina Walk, Dubai' },
      { expiresAt: '2026-09-27T22:00:00.000Z' },
      { cart: { id: 'cart_01j9zk7w3xq8r4t2v6m5n1p0bb', revision: 4 } },
      { merchant: { connectionId: 'mrc_other', name: 'Northline Store' } },
      { lines: [{ ...notebook, quantity: 2, totalMinor: '7000' }, pens] },
      { lines: [notebook] },
    ];
    const hashes = variants.map((v) => quoteHash(demoQuote(v)));
    for (const hash of hashes) expect(hash).not.toBe(base);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('refuses merchant answers that do not add up', () => {
    const [notebook, pens] = demoQuote().lines as [
      QuoteDocument['lines'][number],
      QuoteDocument['lines'][number],
    ];
    const broken: [string, Partial<QuoteDocument>][] = [
      ['line total', { lines: [{ ...notebook, totalMinor: '3400' }, pens] }],
      ['subtotal', { subtotalMinor: '4900' }],
      ['total', { totalMinor: '5000' }],
      ['negative discount', { discountMinor: '-100' }],
      ['discount above subtotal', { discountMinor: '5001', totalMinor: '999' }],
      ['zero quantity', { lines: [{ ...notebook, quantity: 0, totalMinor: '0' }, pens] }],
      [
        'fractional quantity',
        { lines: [{ ...notebook, quantity: 1.5, totalMinor: '5250' }, pens] },
      ],
      [
        'negative price',
        {
          lines: [{ ...notebook, unitPriceMinor: '-3500', totalMinor: '-3500' }, pens],
          subtotalMinor: '-2000',
          totalMinor: '-1000',
        },
      ],
      ['no lines', { lines: [] }],
      ['exclusive tax without an amount', { taxMode: 'exclusive', taxMinor: null }],
    ];
    for (const [label, change] of broken) {
      expect(() => verifyQuoteArithmetic(demoQuote(change)), label).toThrow(QuoteArithmeticError);
    }
    expect(() => verifyQuoteArithmetic(demoQuote({ currency: 'ABC' }))).toThrow(
      UnknownCurrencyError,
    );
    // Exclusive tax is added to the total.
    expect(() =>
      verifyQuoteArithmetic(
        demoQuote({ taxMode: 'exclusive', taxMinor: '250', totalMinor: '6250' }),
      ),
    ).not.toThrow();
  });
});
