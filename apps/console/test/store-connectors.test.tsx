// @vitest-environment jsdom
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { keys } from '../src/lib/queries';
import { ConnectorsPage } from '../src/pages/ConnectorsPage';
import { fakeGateway, mountStudio, TENANT_ID } from './dom';

const brand = { id: 'brd_1', name: 'Noor', status: 'active', widgetId: 'wid_1' };
const seed = (client: QueryClient) => {
  client.setQueryData([TENANT_ID, ...keys.brands], { items: [brand] });
};
const read = (kind: string, key: string, title: string) => ({
  kind,
  key,
  title,
  description: 'Read only',
  risk: 'read',
  approver: 'customer',
});
const catalog = {
  items: [
    { ...read('whmcs', 'invoices.read', 'View invoices') },
    read('shopify', 'orders.read', 'Read the customer’s orders'),
    read('shopify', 'order.status', 'Look up one order'),
    read('woocommerce', 'orders.read', 'Read the customer’s orders'),
    read('woocommerce', 'order.status', 'Look up one order'),
  ],
};
const shop = {
  id: 'con_shop',
  brandId: 'brd_1',
  kind: 'shopify',
  label: 'Noor shop',
  baseUrl: 'https://noor-books.myshopify.com/',
  status: 'disabled',
  capabilities: ['orders.read', 'order.status'],
  grantVersion: 2,
  lastTestedAt: '2026-11-17T09:00:00Z',
  lastError:
    'Shopify refused the access token. Check it, and that the app may read orders (read_orders).',
  identityKeyId: null,
};

beforeAll(() => initI18n('en'));

describe('connecting a store (Shopify and WooCommerce, read only)', () => {
  it('connects Shopify with the shop address and token, both reads ticked, no identifier', async () => {
    const gateway = fakeGateway({
      'GET /v1/admin/connectors/catalog': { json: catalog },
      'GET /v1/admin/connectors': { json: { items: [shop] } },
      'GET /v1/admin/mcp-servers': { json: { items: [] } },
      'GET /v1/admin/tools': { json: { items: [] } },
      'POST /v1/admin/connectors': { status: 201, json: { id: 'con_2' } },
      'POST /v1/admin/connectors/con_shop/reconnect': { json: shop },
    });
    await mountStudio({
      permissions: ['brands.manage', 'tools.read', 'tools.manage'],
      seed,
      screen: <ConnectorsPage />,
    });
    const user = userEvent.setup({ delay: null });
    const section = (await screen.findByRole('heading', { name: 'Shopify', level: 2 })).closest(
      'section',
    ) as HTMLElement;
    // The card says what went wrong in plain words, and offers no WHMCS permission test.
    expect(within(section).getByText(/Shopify refused the access token/)).toBeDefined();
    expect(within(section).queryByText('Test WHMCS user permissions')).toBeNull();

    const summary = within(section).getByText('Connect Shopify');
    await user.click(summary);
    const form = summary.closest('details') as HTMLElement;
    await user.type(within(form).getByLabelText('Name'), 'Second shop');
    await user.type(
      within(form).getByLabelText('Shop address (….myshopify.com)'),
      'https://noor-outlet.myshopify.com',
    );
    await user.type(within(form).getByLabelText('Admin API access token'), 'shpat_secret');
    expect(within(form).queryByLabelText('API identifier')).toBeNull();
    // A store finds customers by verified email: no identity key to choose.
    expect(within(form).queryByLabelText('Verified identity key ID')).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Connect Shopify' }));
    await waitFor(() => expect(gateway.to('POST', '/v1/admin/connectors')).toHaveLength(1));
    expect(gateway.to('POST', '/v1/admin/connectors')[0]?.body).toEqual({
      brandId: 'brd_1',
      kind: 'shopify',
      label: 'Second shop',
      baseUrl: 'https://noor-outlet.myshopify.com',
      secret: 'shpat_secret',
      capabilities: ['orders.read', 'order.status'],
    });

    // A new token replaces the old one; Shopify has no identifier to ask for.
    const card = within(section)
      .getByRole('heading', { name: 'Noor shop' })
      .closest('li') as HTMLElement;
    await user.click(within(card).getByText('Reconnect', { selector: 'summary' }));
    await user.type(within(card).getByLabelText('Admin API access token'), 'shpat_new');
    await user.click(within(card).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/admin/connectors/con_shop/reconnect')).toHaveLength(1),
    );
    expect(gateway.to('POST', '/v1/admin/connectors/con_shop/reconnect')[0]?.body).toEqual({
      secret: 'shpat_new',
    });
  });

  it('connects WooCommerce with the site, the consumer key and secret', async () => {
    const gateway = fakeGateway({
      'GET /v1/admin/connectors/catalog': { json: catalog },
      'GET /v1/admin/connectors': { json: { items: [] } },
      'GET /v1/admin/mcp-servers': { json: { items: [] } },
      'GET /v1/admin/tools': { json: { items: [] } },
      'POST /v1/admin/connectors': { status: 201, json: { id: 'con_3' } },
    });
    await mountStudio({
      permissions: ['brands.manage', 'tools.read', 'tools.manage'],
      seed,
      screen: <ConnectorsPage />,
    });
    const user = userEvent.setup({ delay: null });
    const section = (await screen.findByRole('heading', { name: 'WooCommerce', level: 2 })).closest(
      'section',
    ) as HTMLElement;
    expect(within(section).getByText(/Read only\. The assistant can find/)).toBeDefined();
    await user.click(within(section).getByText('Connect WooCommerce'));
    await user.type(within(section).getByLabelText('Name'), 'Noor store');
    await user.type(
      within(section).getByLabelText('Website HTTPS address'),
      'https://shop.noor.example',
    );
    await user.type(within(section).getByLabelText('Consumer key'), 'ck_key');
    await user.type(within(section).getByLabelText('Consumer secret'), 'cs_secret');
    // Only the order lookup by number and email.
    await user.click(within(section).getByLabelText('Read the customer’s orders'));
    await user.click(within(section).getByRole('button', { name: 'Connect WooCommerce' }));
    await waitFor(() => expect(gateway.to('POST', '/v1/admin/connectors')).toHaveLength(1));
    expect(gateway.to('POST', '/v1/admin/connectors')[0]?.body).toEqual({
      brandId: 'brd_1',
      kind: 'woocommerce',
      label: 'Noor store',
      baseUrl: 'https://shop.noor.example',
      identifier: 'ck_key',
      secret: 'cs_secret',
      capabilities: ['order.status'],
    });
    expect(within(section).getByLabelText('Consumer secret').getAttribute('value')).toBe('');
  });
});
