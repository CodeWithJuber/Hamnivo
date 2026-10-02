import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { neutralizeMentions, openExport, readZip, redact } from '../src/index.js';
import { thrown } from './helpers.js';

const text = (value: string) => new TextEncoder().encode(value);

describe('archive limits', () => {
  it('refuses an archive that expands far beyond its size (zip bomb)', () => {
    const bomb = zipSync({ 'a.json': new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
    expect(
      thrown(() =>
        readZip(bomb, { maxEntries: 10, maxEntryBytes: 1e9, maxTotalBytes: 1e9, maxRatio: 100 }),
      ),
    ).toMatchObject({ code: 'too_large' });
  });

  it('refuses too many files and oversized contents', () => {
    const many = zipSync({ 'a.json': text('{}'), 'b.json': text('{}'), 'c.json': text('{}') });
    const limits = { maxEntries: 2, maxEntryBytes: 1e6, maxTotalBytes: 1e6, maxRatio: 1e6 };
    expect(thrown(() => readZip(many, limits))).toMatchObject({ code: 'too_many_files' });
    expect(
      thrown(() => readZip(many, { ...limits, maxEntries: 10, maxTotalBytes: 3 })),
    ).toMatchObject({ code: 'too_large' });
  });

  it('refuses unsafe file names', () => {
    const unsafe = zipSync({ '../../etc/passwd.json': text('{}') });
    expect(thrown(() => readZip(unsafe))).toMatchObject({ code: 'unsafe_path' });
  });

  it('accepts a plain JSON or NDJSON file and refuses anything else', () => {
    expect([...openExport(text('  {"id":1}'), 'chat.json').keys()]).toEqual(['chat.json']);
    expect(thrown(() => openExport(text('hello'), 'x.txt'))).toMatchObject({
      code: 'not_supported',
    });
    expect(thrown(() => openExport(new Uint8Array(), 'x.json'))).toMatchObject({ code: 'empty' });
  });
});

describe('sample redaction', () => {
  it('masks emails, phone and card numbers, and link parameters', () => {
    expect(redact('Mail sara.nguyen@example.com or call +44 7700 900123.')).toBe(
      'Mail [email] or call [number].',
    );
    expect(redact('رقمي ٠٣٠٠١٢٣٤٥٦٧ شكرا')).toBe('رقمي [number] شكرا');
    expect(redact('Card 4111 1111 1111 1111')).toBe('Card [number]');
    expect(redact('See https://shop.example/track?id=9921&token=abc')).toBe(
      'See https://shop.example/track',
    );
    expect(redact('Order 4821 arrives in 3 days')).toBe('Order 4821 arrives in 3 days');
  });

  it('turns Chatwoot mention links into plain names, so imported notes notify nobody', () => {
    expect(neutralizeMentions('Ask [@Liam Davies](mention://user/12/Liam%20Davies) please')).toBe(
      'Ask @Liam Davies please',
    );
    expect(
      neutralizeMentions('[@Billing](mention://team/3/Billing) and [a link](https://x.y)'),
    ).toBe('@Billing and [a link](https://x.y)');
  });
});
