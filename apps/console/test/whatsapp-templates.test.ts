import { describe, expect, it } from 'vitest';
import type { WhatsappTemplate } from '../src/lib/inbox';
import {
  byLanguage,
  languageName,
  matchTemplates,
  prefill,
  previewPieces,
  templateFields,
  templateValues,
  unfilled,
} from '../src/lib/whatsapp-templates';

const template = (patch: Partial<WhatsappTemplate> = {}): WhatsappTemplate => ({
  name: 'order_update',
  language: 'en_US',
  category: 'UTILITY',
  header: 'From {{brand}}',
  body: 'Hi {{first_name}}, order {{order}} ships {{1}}.',
  footer: null,
  buttons: [
    { type: 'quick_reply', text: 'Thanks' },
    { type: 'url', text: 'Track' },
  ],
  variables: {
    header: ['brand'],
    body: ['first_name', 'order', '1'],
    buttons: [{ index: 1, type: 'url', label: 'Track' }],
  },
  unsupported: null,
  ...patch,
});

const conversation = {
  customer: { displayName: 'Hana Ali', identity: 'unknown' as const, language: null },
  ticket: null,
  brand: { id: 'brd_1', name: 'Noor Books' },
};

describe('WhatsApp templates (D14)', () => {
  it('asks for header, body and button values, in that order', () => {
    expect(templateFields(template()).map((f) => f.key)).toEqual([
      'header.brand',
      'body.first_name',
      'body.order',
      'body.1',
      'buttons.1',
    ]);
  });

  it('fills in named values it knows, never numbered ones or buttons', () => {
    expect(prefill(template(), conversation)).toEqual({
      'header.brand': 'Noor Books',
      'body.first_name': 'Hana',
    });
    const ticket = {
      number: 1042,
      reference: '#1042',
      state: 'open' as const,
      source: 'staff' as const,
      openedAt: '2026-10-09T08:00:00.000Z',
    };
    expect(prefill(template(), { ...conversation, ticket, brand: null })).toEqual({
      'body.first_name': 'Hana',
      'body.order': '1042',
    });
  });

  it('counts what is still empty, and sends only the values the template asks for', () => {
    const fields = templateFields(template());
    const values = { 'header.brand': 'Noor', 'body.first_name': ' Hana ', 'body.extra': 'x' };
    expect(unfilled(fields, values).map((f) => f.key)).toEqual([
      'body.order',
      'body.1',
      'buttons.1',
    ]);
    expect(
      templateValues(fields, {
        ...values,
        'body.order': '7',
        'body.1': 'today',
        'buttons.1': 'a1',
      }),
    ).toEqual({
      header: { brand: 'Noor' },
      body: { first_name: 'Hana', order: '7', '1': 'today' },
      buttons: { '1': 'a1' },
    });
    const code = templateFields(
      template({
        variables: {
          header: [],
          body: [],
          buttons: [{ index: 0, type: 'copy_code', label: 'Copy' }],
        },
      }),
    );
    expect(unfilled(code, { 'buttons.0': 'SIXTEEN-CHARS-XX' })).toHaveLength(1);
    expect(unfilled(code, { 'buttons.0': 'SAVE10' })).toHaveLength(0);
  });

  it('previews the text with the values in, and what is still empty as it is written', () => {
    expect(previewPieces('Hi {{1}}, see {{ when }}!', 'body', { 'body.1': 'Hana' })).toEqual([
      { text: 'Hi ' },
      { text: 'Hana', variable: '1', filled: true },
      { text: ', see ' },
      { text: '{{ when }}', variable: 'when', filled: false },
      { text: '!' },
    ]);
  });

  it('groups by language, ones that can be sent first, and searches names and text', () => {
    const items = [
      template({ name: 'a', unsupported: 'not_approved' }),
      template({ name: 'b', language: 'ar' }),
      template({ name: 'c' }),
    ];
    expect(byLanguage(items).map((g) => [g.language, g.templates.map((t) => t.name)])).toEqual([
      ['en_US', ['c', 'a']],
      ['ar', ['b']],
    ]);
    expect(matchTemplates([template()], 'ORDER UPDATE')).toHaveLength(1);
    expect(matchTemplates([template()], 'ships')).toHaveLength(1);
    expect(matchTemplates([template()], 'refund')).toHaveLength(0);
  });

  it('names Meta’s language codes in the interface language', () => {
    expect(languageName('en_US', 'en')).toBe('American English');
    expect(languageName('ar', 'en')).toBe('Arabic');
    expect(languageName('not a code!', 'en')).toBe('not a code!');
  });
});
