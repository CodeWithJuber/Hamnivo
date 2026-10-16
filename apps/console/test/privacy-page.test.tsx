// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import type { RetentionPolicy } from '../src/lib/privacy';
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

describe('Settings → Privacy (A10)', () => {
  it('is for owners: an administrator sees that it is not theirs', async () => {
    fakeGateway({});
    await mountStudio({
      at: '/settings/privacy',
      permissions: presetPermissions('admin'),
      screen: <PrivacyPage />,
    });
    expect(await screen.findByTestId('forbidden')).toBeTruthy();
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
