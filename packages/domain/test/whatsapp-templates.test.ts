import { describe, expect, it } from 'vitest';
import {
  invalidValues,
  missingValues,
  parseWhatsappTemplate,
  renderTemplate,
  templateProcessedParams,
  templateVariables,
  unsupportedReason,
  type WhatsappTemplate,
} from '../src/whatsapp-templates.js';

/** Meta's shape, as Chatwoot keeps it in `message_templates`. */
const orderUpdate = {
  id: '1',
  name: 'order_update',
  language: 'en_US',
  status: 'APPROVED',
  category: 'UTILITY',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
    { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is on its way. Track it below.' },
    { type: 'FOOTER', text: 'Reply STOP to opt out' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Thanks' },
        { type: 'URL', text: 'Track', url: 'https://shop.example/track/{{1}}' },
        { type: 'COPY_CODE', text: 'Copy code', example: ['SAVE10'] },
      ],
    },
  ],
};

const parsed = parseWhatsappTemplate(orderUpdate) as WhatsappTemplate;

describe('WhatsApp templates (D14)', () => {
  it("reads Meta's template shape", () => {
    expect(parsed).toMatchObject({
      name: 'order_update',
      language: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      parameterFormat: 'positional',
      header: { format: 'text', text: 'Order {{1}}' },
      footer: 'Reply STOP to opt out',
    });
    expect(parsed.buttons.map((b) => b.type)).toEqual(['quick_reply', 'url', 'copy_code']);
    expect(parseWhatsappTemplate({ components: [] })).toBeNull();
  });

  it('lists what it asks for, in order, once each', () => {
    expect(templateVariables(parsed)).toEqual({
      header: ['1'],
      body: ['1', '2'],
      buttons: [
        { index: 1, type: 'url', label: 'Track' },
        { index: 2, type: 'copy_code', label: 'Copy code' },
      ],
    });
    const named = parseWhatsappTemplate({
      name: 'hello',
      language: 'ar',
      status: 'APPROVED',
      parameter_format: 'NAMED',
      components: [{ type: 'BODY', text: 'مرحبا {{customer_name}}، {{customer_name}}' }],
    }) as WhatsappTemplate;
    expect(named.parameterFormat).toBe('named');
    expect(templateVariables(named).body).toEqual(['customer_name']);
  });

  it('says which templates cannot be sent from here', () => {
    expect(unsupportedReason(parsed)).toBeNull();
    expect(unsupportedReason({ ...parsed, status: 'PENDING' })).toBe('not_approved');
    expect(unsupportedReason({ ...parsed, category: 'AUTHENTICATION' })).toBe('authentication');
    expect(unsupportedReason({ ...parsed, header: { format: 'image', text: null } })).toBe(
      'media_header',
    );
  });

  it('names every value still missing, and values it does not ask for', () => {
    expect(missingValues(parsed, { body: { '1': 'Amina' } })).toEqual([
      'header.1',
      'body.2',
      'buttons.1',
      'buttons.2',
    ]);
    expect(missingValues(parsed, { body: { '1': '  ', '2': 'x' } })).toContain('body.1');
    expect(
      invalidValues(parsed, { body: { '3': 'x' }, buttons: { '0': 'x', '2': 'MUCHTOOLONGCODE1' } }),
    ).toEqual(['body.3', 'buttons.0', 'buttons.2']);
  });

  const values = {
    header: { '1': '1042' },
    body: { '1': 'Amina', '2': '1042' },
    buttons: { '1': '1042', '2': 'SAVE10' },
  };

  it('renders the text the customer reads', () => {
    expect(renderTemplate(parsed, values)).toBe(
      'Order 1042\n\nHi Amina, your order 1042 is on its way. Track it below.\n\nReply STOP to opt out',
    );
    // Chatwoot strips quotes and angle brackets from values; the transcript matches.
    expect(
      renderTemplate(parsed, { ...values, body: { '1': '<b>"Amina"</b>', '2': '1' } }),
    ).toContain('Hi bAmina/b,');
  });

  it("builds Chatwoot's processed_params, buttons in their places", () => {
    expect(templateProcessedParams(parsed, values)).toEqual({
      header: { '1': '1042' },
      body: { '1': 'Amina', '2': '1042' },
      buttons: [
        { type: 'none' },
        { type: 'url', parameter: '1042' },
        { type: 'copy_code', parameter: 'SAVE10' },
      ],
    });
    const plain = parseWhatsappTemplate({
      name: 'hello',
      language: 'en',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Hello! How can we help?' }],
    }) as WhatsappTemplate;
    expect(templateProcessedParams(plain, {})).toEqual({});
    expect(renderTemplate(plain, {})).toBe('Hello! How can we help?');
  });
});
