// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import type {
  PrivacyCustomer,
  PrivacyCustomerSummary,
  PrivacyRequest,
  RetentionPolicy,
} from '../src/lib/privacy';
import { PrivacyPage } from '../src/pages/settings/PrivacyPage';
import { fakeGateway, mountStudio } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const policy = (patch: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  conversationDays: null,
  pending: null,
  choices: [90, 180, 365, 730, 1095, 1825, 2555],
  graceDays: 7,
  sweep: { state: 'idle', sweptAt: null, conversationsDeleted: 0, customersDeleted: 0 },
  updatedAt: null,
  version: 0,
  ...patch,
});

const customer: PrivacyCustomer = {
  id: 'cus_01abc',
  brand: { id: 'brd_1', name: 'Noor Shop' },
  kind: 'verified',
  name: 'Fatima Noor',
  email: 'fatima@example.com',
  externalId: 'u-42',
  channel: null,
  lastSeenAt: inDays(-2),
  erasedAt: null,
};

const summary = (patch: Partial<PrivacyCustomerSummary> = {}): PrivacyCustomerSummary => ({
  customer,
  conversations: 3,
  orders: 1,
  memories: 2,
  sharedContact: false,
  requests: [],
  ...patch,
});

const request = (patch: Partial<PrivacyRequest> = {}): PrivacyRequest => ({
  id: 'prq_1',
  kind: 'export',
  customerId: customer.id,
  brand: customer.brand,
  state: 'queued',
  reason: 'access_request',
  reference: null,
  requestedBy: { id: 'staff_me', name: 'Ali' },
  counts: {},
  problem: null,
  file: null,
  createdAt: inDays(0),
  completedAt: null,
  ...patch,
});

describe('Settings → Privacy (A10)', () => {
  it('is not for agents', async () => {
    fakeGateway({});
    await mountStudio({
      at: '/settings/privacy',
      permissions: presetPermissions('agent'),
      screen: <PrivacyPage />,
    });
    expect(await screen.findByTestId('forbidden')).toBeTruthy();
  });

  it('gives administrators one customer’s data, and leaves retention to owners', async () => {
    fakeGateway({ 'GET /v1/admin/privacy/requests': { json: { items: [] } } });
    await mountStudio({
      at: '/settings/privacy',
      permissions: presetPermissions('admin'),
      screen: <PrivacyPage />,
    });
    expect(await screen.findByText('A customer’s data')).toBeTruthy();
    expect(await screen.findByText('No exports or erasures yet.')).toBeTruthy();
    expect(screen.queryByText('How long conversations are kept')).toBeNull();
  });

  it('finds a customer, prepares their file and erases them after their ID is typed', async () => {
    const gateway = fakeGateway({
      'GET /v1/admin/privacy/retention': { json: policy() },
      'GET /v1/admin/privacy/requests': { json: { items: [] } },
      'GET /v1/admin/privacy/customers': { json: { items: [customer] } },
      [`GET /v1/admin/privacy/customers/${customer.id}`]: { json: summary() },
      [`POST /v1/admin/privacy/customers/${customer.id}/export`]: {
        status: 202,
        json: request(),
      },
      [`POST /v1/admin/privacy/customers/${customer.id}/erase`]: {
        status: 202,
        json: request({ id: 'prq_2', kind: 'erase', reason: 'erasure_request' }),
      },
    });
    await mountStudio({ at: '/settings/privacy', permissions: owner, screen: <PrivacyPage /> });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Find a customer'), 'fatima');
    await user.click(screen.getByTestId('privacy-find'));
    expect(gateway.to('GET', '/v1/admin/privacy/customers')[0]?.query).toEqual({
      query: 'fatima',
    });
    await user.click(await screen.findByTestId('privacy-customer'));
    const card = await screen.findByTestId('privacy-customer-card');
    expect(card.textContent).toContain(customer.id);
    expect(screen.getByTestId('privacy-orders-kept')).toBeTruthy();

    await user.click(screen.getByTestId('privacy-export'));
    await user.type(await screen.findByLabelText('Reference (optional)'), 'Ticket 42');
    await user.click(screen.getByTestId('privacy-export-dialog-submit'));
    await waitFor(() =>
      expect(
        gateway.to('POST', `/v1/admin/privacy/customers/${customer.id}/export`)[0]?.body,
      ).toEqual({ reason: 'access_request', reference: 'Ticket 42' }),
    );
    expect(
      gateway.to('POST', `/v1/admin/privacy/customers/${customer.id}/export`)[0]?.headers[
        'idempotency-key'
      ],
    ).toBeTruthy();
    expect((await screen.findByTestId('privacy-started')).textContent).toContain(
      'Preparing the file',
    );

    await user.click(screen.getByTestId('privacy-erase'));
    const confirm = await screen.findByLabelText(`Type the customer ID to confirm: ${customer.id}`);
    await user.type(confirm, 'cus_wrong');
    await user.click(screen.getByTestId('privacy-erase-dialog-submit'));
    expect(await screen.findByText('Type the customer ID exactly as shown.')).toBeTruthy();
    expect(gateway.to('POST', `/v1/admin/privacy/customers/${customer.id}/erase`)).toEqual([]);
    await user.clear(confirm);
    await user.type(confirm, customer.id.toUpperCase());
    await user.click(screen.getByTestId('privacy-erase-dialog-submit'));
    await waitFor(() =>
      expect(
        gateway.to('POST', `/v1/admin/privacy/customers/${customer.id}/erase`)[0]?.body,
      ).toEqual({ reason: 'erasure_request', confirm: customer.id.toUpperCase() }),
    );
    expect((await screen.findByTestId('privacy-started')).textContent).toContain(
      'Erasing has started',
    );
  });

  it('lists requests with their file, a deleted file and why one stopped', async () => {
    fakeGateway({
      'GET /v1/admin/privacy/retention': { json: policy() },
      'GET /v1/admin/privacy/requests': {
        json: {
          items: [
            request({
              id: 'prq_3',
              state: 'completed',
              counts: { conversations: 3, files: 2 },
              file: { byteSize: 2048, expiresAt: inDays(1) },
              completedAt: inDays(0),
            }),
            request({ id: 'prq_4', state: 'completed', completedAt: inDays(-2) }),
            request({
              id: 'prq_5',
              kind: 'erase',
              state: 'blocked',
              problem: 'authority_not_admin',
            }),
          ],
        },
      },
    });
    await mountStudio({ at: '/settings/privacy', permissions: owner, screen: <PrivacyPage /> });
    const rows = await screen.findAllByTestId('privacy-request');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Conversations: 3 · Files: 2');
    expect(screen.getAllByTestId('privacy-download')).toHaveLength(1);
    expect(rows[1]?.textContent).toContain('Deleted after 24 hours');
    expect(rows[2]?.textContent).toContain('must be an administrator');
  });

  it('turns retention on after showing what goes and when, then can undo it', async () => {
    let current = policy();
    const gateway = fakeGateway({
      'GET /v1/admin/privacy/retention': () => ({ json: current }),
      'GET /v1/admin/privacy/retention/preview': (call) => ({
        json: {
          conversationDays: Number(call.query.days),
          conversations: 1234,
          oldestActivityAt: inDays(-900),
          deletesFrom: inDays(7),
        },
      }),
      'PUT /v1/admin/privacy/retention': (call) => {
        const body = call.body as { conversationDays: number | null; version: number };
        current =
          body.conversationDays === null
            ? policy({ version: body.version + 1 })
            : policy({
                pending: { conversationDays: body.conversationDays, from: inDays(7) },
                version: body.version + 1,
              });
        return { json: current };
      },
    });
    await mountStudio({ at: '/settings/privacy', permissions: owner, screen: <PrivacyPage /> });
    const user = userEvent.setup();
    const select = await screen.findByLabelText('Keep resolved conversations');
    expect((select as HTMLSelectElement).value).toBe('forever');
    expect(screen.getByTestId('retention-save').hasAttribute('disabled')).toBe(true);

    await user.selectOptions(select, '365');
    expect(
      await screen.findByText('Resolved conversations older than this today: 1,234.'),
    ).toBeTruthy();
    expect(screen.getByTestId('retention-when').textContent).toContain('a week after you save');

    await user.click(screen.getByTestId('retention-save'));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/privacy/retention')[0]?.body).toEqual({
        conversationDays: 365,
        version: 0,
      }),
    );
    const pending = await screen.findByTestId('retention-pending');
    expect(pending.textContent).toContain('older than 1 year will be deleted');

    await user.click(screen.getByTestId('retention-undo'));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/privacy/retention')[1]?.body).toEqual({
        conversationDays: null,
        version: 1,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('retention-pending')).toBeNull());
  });

  it('says a longer period applies at once', async () => {
    fakeGateway({
      'GET /v1/admin/privacy/retention': { json: policy({ conversationDays: 365, version: 3 }) },
      'GET /v1/admin/privacy/retention/preview': {
        json: {
          conversationDays: 730,
          conversations: 0,
          oldestActivityAt: null,
          deletesFrom: inDays(0),
        },
      },
    });
    await mountStudio({ at: '/settings/privacy', permissions: owner, screen: <PrivacyPage /> });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Keep resolved conversations'), '730');
    expect(screen.getByTestId('retention-when').textContent).toBe(
      'This deletes nothing sooner, so it applies at once.',
    );
  });

  it('explains a stopped sweep and shows what was deleted', async () => {
    fakeGateway({
      'GET /v1/admin/privacy/retention': {
        json: policy({
          conversationDays: 365,
          version: 2,
          sweep: {
            state: 'blocked',
            sweptAt: inDays(-1),
            conversationsDeleted: 40,
            customersDeleted: 3,
          },
        }),
      },
      'GET /v1/admin/privacy/retention/preview': {
        json: {
          conversationDays: 365,
          conversations: 2,
          oldestActivityAt: null,
          deletesFrom: inDays(0),
        },
      },
    });
    await mountStudio({ at: '/settings/privacy', permissions: owner, screen: <PrivacyPage /> });
    expect((await screen.findByTestId('retention-blocked')).textContent).toContain(
      'must be an administrator',
    );
    expect(screen.getByTestId('retention-progress').textContent).toBe(
      'Deleted so far: 40 conversations and 3 customers.',
    );
  });
});
