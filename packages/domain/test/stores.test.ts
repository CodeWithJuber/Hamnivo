import { describe, expect, it } from 'vitest';
import {
  emailOf,
  orderNumberOf,
  publicOrder,
  STORE_CAPABILITIES,
  STORE_SPEC,
  sameEmail,
  shopifyOrders,
  storeCapability,
  wooOrder,
} from '../src/connectors/stores.js';

describe('store orders, read only', () => {
  it('offers two read-only capabilities and nothing else', () => {
    expect(STORE_CAPABILITIES).toEqual(['orders.read', 'order.status']);
    for (const key of STORE_CAPABILITIES) {
      expect(STORE_SPEC[key].risk).toBe('read');
      expect(STORE_SPEC[key].inputSchema.additionalProperties).toBe(false);
    }
    expect(STORE_SPEC['order.status'].inputSchema.required).toEqual(['orderNumber', 'email']);
    expect(storeCapability('orders.read')).toBe(true);
    expect(storeCapability('refund.handoff')).toBe(false);
    expect(storeCapability('__proto__')).toBe(false);
  });

  it('reads order numbers and emails as customers type them', () => {
    expect(orderNumberOf(' #1001 ')).toBe('1001');
    expect(orderNumberOf('NL-1048')).toBe('NL-1048');
    for (const bad of ['', '#', '10 01', '1001; drop', 'a'.repeat(33), 1001, null]) {
      expect(orderNumberOf(bad)).toBeNull();
    }
    expect(emailOf(' Amina@Example.COM ')).toBe('amina@example.com');
    expect(emailOf('not an email')).toBeNull();
    expect(emailOf('a@b')).toBeNull();
    expect(sameEmail('AMINA@example.com', 'amina@example.com ')).toBe(true);
    expect(sameEmail('amina@example.com', 'sara@example.com')).toBe(false);
    expect(sameEmail(null, null)).toBe(false);
  });

  it('maps a Shopify order to the shared shape, without the address or payment details', () => {
    const orders = shopifyOrders({
      orders: {
        nodes: [
          {
            name: '#1001',
            email: 'Amina@example.com',
            createdAt: '2026-11-10T09:00:00Z',
            displayFinancialStatus: 'PAID',
            displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
            cancelledAt: null,
            currentSubtotalLineItemsQuantity: 3,
            currentTotalPriceSet: { shopMoney: { amount: '59.90', currencyCode: 'EUR' } },
            fulfillments: [
              {
                trackingInfo: [
                  { company: 'DHL', number: 'JD014600', url: 'https://track.example/JD014600' },
                  { company: '<b>x</b>', number: null, url: 'javascript:alert(1)' },
                ],
              },
            ],
            shippingAddress: { address1: '1 Secret Street' },
            paymentGatewayNames: ['visa'],
          },
          { email: 'no-name@example.com' },
        ],
      },
    });
    expect(orders).toEqual([
      {
        number: '#1001',
        email: 'amina@example.com',
        placedAt: '2026-11-10T09:00:00.000Z',
        storeStatus: 'paid',
        payment: 'paid',
        fulfilment: 'partially_fulfilled',
        cancelled: false,
        itemCount: 3,
        total: { amount: '59.90', currency: 'EUR' },
        tracking: [
          { company: 'DHL', number: 'JD014600', url: 'https://track.example/JD014600' },
          { company: 'x', number: null, url: null },
        ],
      },
    ]);
    const shown = publicOrder(orders![0]!);
    expect(shown).not.toHaveProperty('email');
    expect(JSON.stringify(shown)).not.toMatch(/Secret Street|visa/);
    expect(shopifyOrders({ orders: null })).toBeNull();
    expect(shopifyOrders('oops')).toBeNull();
  });

  it('maps a WooCommerce order, its status, items and Shipment Tracking entry', () => {
    const order = wooOrder({
      id: 1048,
      number: '1048',
      status: 'completed',
      date_created_gmt: '2026-11-11T08:30:00',
      currency: 'gbp',
      total: '24.00',
      billing: { email: 'sara@example.com', phone: '+44 7700 900123', address_1: '2 Hidden Road' },
      line_items: [{ quantity: 2 }, { quantity: 1 }],
      meta_data: [
        { key: '_customer_note', value: 'leave at the door' },
        {
          key: '_wc_shipment_tracking_items',
          value: [
            { tracking_provider: 'Royal Mail', tracking_number: 'RM123', custom_tracking_link: '' },
          ],
        },
      ],
    });
    expect(order).toEqual({
      number: '1048',
      email: 'sara@example.com',
      placedAt: '2026-11-11T08:30:00.000Z',
      storeStatus: 'completed',
      payment: 'paid',
      fulfilment: 'fulfilled',
      cancelled: false,
      itemCount: 3,
      total: { amount: '24.00', currency: 'GBP' },
      tracking: [{ company: 'Royal Mail', number: 'RM123', url: null }],
    });
    expect(JSON.stringify(order)).not.toMatch(/Hidden Road|7700|leave at the door/);
    expect(wooOrder({ id: 7, status: 'cancelled' })).toMatchObject({
      number: '7',
      cancelled: true,
      payment: null,
      itemCount: null,
      total: null,
    });
    expect(wooOrder({ status: 'processing' })).toBeNull();
  });
});
