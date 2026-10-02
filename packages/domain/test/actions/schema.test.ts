import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  SCHEMA_LIMITS,
  sanitizeToolSchema,
  toJsonSchema,
  validateAgainstSchema,
} from '../../src/actions/index.js';

const ADDRESS = {
  type: 'object',
  properties: {
    orderReference: {
      type: 'string',
      pattern: '^[A-Z]{2,4}-[A-Z0-9]{3,10}$',
      description: 'Order',
    },
    address: { type: 'string', minLength: 5, maxLength: 200 },
    express: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  },
  required: ['orderReference', 'address'],
};

describe('sanitizeToolSchema', () => {
  it('keeps the portable subset and forbids unknown fields', () => {
    const result = sanitizeToolSchema(ADDRESS, { trusted: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.properties?.orderReference?.pattern).toBe(
      ADDRESS.properties.orderReference.pattern,
    );
    expect(result.schema.properties?.notes?.nullable).toBe(true);
    expect(toJsonSchema(result.schema)).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['address', 'orderReference'],
    });
  });

  it('drops patterns from untrusted (MCP) schemas and caps string length', () => {
    const result = sanitizeToolSchema(ADDRESS, { trusted: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.properties?.orderReference?.pattern).toBeUndefined();
    expect(result.schema.properties?.notes?.maxLength).toBe(SCHEMA_LIMITS.stringLength);
  });

  it.each([
    [{ type: 'object', properties: { a: { $ref: 'https://evil.example/schema' } } }, '/a'],
    [{ type: 'object', properties: { a: { anyOf: [{ type: 'string' }] } } }, '/a'],
    [{ type: 'string' }, ''],
    [{ type: 'object', properties: { 'bad name!': { type: 'string' } } }, '/bad name!'],
    [
      {
        type: 'object',
        properties: {
          a: {
            type: 'object',
            properties: {
              b: {
                type: 'object',
                properties: {
                  c: {
                    type: 'object',
                    properties: { d: { type: 'object', properties: { e: { type: 'string' } } } },
                  },
                },
              },
            },
          },
        },
      },
      '/a/b/c/d/e',
    ],
    [
      {
        type: 'object',
        properties: { a: { type: 'string', enum: Array.from({ length: 101 }, (_, i) => `v${i}`) } },
      },
      '/a',
    ],
  ])('refuses what it cannot represent safely: %j', (raw, path) => {
    const result = sanitizeToolSchema(raw, { trusted: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe(path);
  });

  it('refuses an invalid trusted pattern and strips control characters from descriptions', () => {
    expect(
      sanitizeToolSchema(
        { type: 'object', properties: { a: { type: 'string', pattern: '(' } } },
        { trusted: true },
      ).ok,
    ).toBe(false);
    const result = sanitizeToolSchema(
      { type: 'object', description: 'Order\u202e lookup\u0007' },
      { trusted: false },
    );
    expect(result.ok && result.schema.description).toBe('Order lookup');
  });
});

describe('validateAgainstSchema', () => {
  const schema = (() => {
    const result = sanitizeToolSchema(ADDRESS, { trusted: true });
    if (!result.ok) throw new Error(result.problem);
    return result.schema;
  })();

  it('accepts valid arguments and normalizes text to NFC', () => {
    const result = validateAgainstSchema(schema, {
      orderReference: 'NL-1048',
      address: 'Café Street 12',
    });
    expect(result).toEqual({
      ok: true,
      value: { orderReference: 'NL-1048', address: 'Café Street 12' },
    });
  });

  it('gives the same canonical hash for the same arguments in any key order', () => {
    const a = validateAgainstSchema(schema, { address: 'Palm Road 5', orderReference: 'NL-1048' });
    const b = validateAgainstSchema(schema, { orderReference: 'NL-1048', address: 'Palm Road 5' });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(canonicalHash(a.value)).toBe(canonicalHash(b.value));
  });

  it.each([
    [{ address: 'Palm Road 5' }, '/orderReference'],
    [{ orderReference: 'nope', address: 'Palm Road 5' }, '/orderReference'],
    [{ orderReference: 'NL-1048', address: 'x' }, '/address'],
    [{ orderReference: 'NL-1048', address: 'Palm Road 5', express: 'yes' }, '/express'],
    [{ orderReference: 'NL-1048', address: 'Palm Road 5', refundTo: 'attacker' }, '/'],
    ['NL-1048', '/'],
  ])('refuses %j', (value, path) => {
    const result = validateAgainstSchema(schema, value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path)).toContain(path);
  });
});
