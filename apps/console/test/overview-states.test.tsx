// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { keys } from '../src/lib/queries';
import { OverviewPage } from '../src/pages/OverviewPage';
import { type Answer, fakeGateway, mountStudio, TENANT_ID } from './dom';
import { renderStudio } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const brand = {
  id: 'brd_1',
  workspaceId: 'wsp_1',
  name: 'Noor Books',
  widgetId: 'wid_1',
  allowedOrigins: ['https://noor.example'],
  businessHours: null,
  status: 'active',
  createdAt: '2026-10-01T09:00:00.000Z',
};
const down: Answer = { problem: { status: 503, code: 'UNAVAILABLE' } };
const BRANDS = { json: { items: [brand] } };
const NO_STOPS = { json: { items: [] } };
const NO_RUNS = { json: { items: [], nextCursor: null } };

/** A card of Home, found as a screen reader finds it: the region named by its heading. */
const card = (id: 'overview-brands' | 'overview-stops') =>
  screen.getByRole('region', {
    name: id === 'overview-brands' ? 'Brands' : 'AI stop switches',
  });

describe('Home when part of it fails (HNV-03-04)', () => {
  it('keeps what loaded, marks the card that failed, and points to the inbox', async () => {
    const user = userEvent.setup({ delay: null });
    let stopsUp = false;
    const gateway = fakeGateway({
      'GET /v1/admin/brands': BRANDS,
      'GET /v1/admin/kill-switches': () => (stopsUp ? NO_STOPS : down),
      'GET /v1/admin/runs': NO_RUNS,
    });
    await mountStudio({ permissions: owner, screen: <OverviewPage /> });

    // The brands load as usual; the AI stops card says it failed, with its own retry.
    await within(card('overview-brands')).findByText('Noor Books');
    const stops = card('overview-stops');
    const retry = await within(stops).findByRole('button', { name: 'Try again' });
    const notice = await screen.findByTestId('overview-degraded');
    expect(notice.textContent).toContain('Part of Home couldn’t load');
    expect(notice.textContent).toContain('including your inbox');
    expect(within(notice).getByRole('link', { name: 'Open inbox' }).getAttribute('href')).toBe(
      '/inbox',
    );

    // Trying again asks again for that card only, and the notice goes once it works.
    const brandsAsked = gateway.to('GET', '/v1/admin/brands').length;
    const runsAsked = gateway.to('GET', '/v1/admin/runs').length;
    stopsUp = true;
    await user.click(retry);
    await within(stops).findByText('The AI isn’t stopped anywhere.');
    await waitFor(() => expect(screen.queryByTestId('overview-degraded')).toBeNull());
    expect(gateway.to('GET', '/v1/admin/brands')).toHaveLength(brandsAsked);
    expect(gateway.to('GET', '/v1/admin/runs')).toHaveLength(runsAsked);
  });

  it('says when shown data could not be refreshed, and how old it is', async () => {
    const user = userEvent.setup({ delay: null });
    let brandsUp = true;
    fakeGateway({
      'GET /v1/admin/brands': () => (brandsUp ? BRANDS : down),
      'GET /v1/admin/kill-switches': NO_STOPS,
      'GET /v1/admin/runs': NO_RUNS,
    });
    const { client } = await mountStudio({ permissions: owner, screen: <OverviewPage /> });
    const brands = card('overview-brands');
    await within(brands).findByText('Noor Books');
    expect(within(brands).queryByTestId('stale-notice')).toBeNull();

    brandsUp = false;
    await client.refetchQueries({ queryKey: [TENANT_ID, ...keys.brands], exact: true });
    const stale = await within(brands).findByTestId('stale-notice');
    expect(stale.getAttribute('role')).toBe('status');
    expect(stale.textContent).toMatch(/Couldn’t refresh this\. Showing what was loaded .+\./);
    // What was there stays, and so does the rest of Home.
    expect(within(brands).getByText('Noor Books')).toBeTruthy();
    expect(screen.getByTestId('overview-degraded')).toBeTruthy();

    brandsUp = true;
    await user.click(within(stale).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(brands).queryByTestId('stale-notice')).toBeNull());
    expect(screen.queryByTestId('overview-degraded')).toBeNull();
  });

  it('shows no notice when everything loaded', async () => {
    fakeGateway({
      'GET /v1/admin/brands': BRANDS,
      'GET /v1/admin/kill-switches': NO_STOPS,
      'GET /v1/admin/runs': NO_RUNS,
    });
    await mountStudio({ permissions: owner, screen: <OverviewPage /> });
    await within(card('overview-brands')).findByText('Noor Books');
    await within(card('overview-stops')).findByText('The AI isn’t stopped anywhere.');
    expect(screen.queryByTestId('overview-degraded')).toBeNull();
    expect(screen.queryByTestId('stale-notice')).toBeNull();
  });
});

describe('Home while it loads (HNV-03-03)', () => {
  it('holds each card’s place with a placeholder in its shape, and says what is loading', async () => {
    const html = await renderStudio({
      at: '/overview',
      permissions: owner,
      screen: <OverviewPage />,
    });
    for (const id of ['brands-skeleton', 'runs-skeleton', 'stops-skeleton']) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading');
    expect(html).not.toContain('data-testid="overview-degraded"');
  });
});
