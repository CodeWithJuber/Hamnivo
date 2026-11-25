// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { PublicProfileSection } from '../src/pages/inbox/PublicProfile';
import { fakeGateway, mountStudio } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const agent = presetPermissions('agent');

describe('how customers see you', () => {
  it('shows the name customers see now, and keeps an address that is not https out', async () => {
    const gateway = fakeGateway({
      'GET /v1/inbox/profile': { json: { publicName: null, photoUrl: null, shownAs: 'Sara' } },
      'PATCH /v1/inbox/profile': {
        json: {
          publicName: 'Sara N',
          photoUrl: 'https://cdn.noor.example/sara.jpg',
          shownAs: 'Sara N',
        },
      },
    });
    await mountStudio({ permissions: agent, screen: <PublicProfileSection /> });
    const preview = await screen.findByTestId('public-profile-preview');
    expect(preview.textContent).toContain('Sara');
    // Initials stand in for a photo until there is one.
    expect(preview.textContent).toContain('S');
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByLabelText('Photo address'), 'http://cdn.noor.example/sara.jpg');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use an address that starts with https://.')).toBeTruthy();
    expect(gateway.to('PATCH', '/v1/inbox/profile')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Photo address'));
    await user.type(screen.getByLabelText('Photo address'), 'https://cdn.noor.example/sara.jpg');
    await user.type(screen.getByLabelText('First name customers see'), 'Sara N');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(gateway.to('PATCH', '/v1/inbox/profile')).toHaveLength(1));
    expect(gateway.to('PATCH', '/v1/inbox/profile')[0]?.body).toEqual({
      publicName: 'Sara N',
      photoUrl: 'https://cdn.noor.example/sara.jpg',
    });
    expect(preview.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.noor.example/sara.jpg',
    );
  });
});
