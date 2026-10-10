// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CommandPalette } from '../src/components/CommandPalette';
import { initI18n } from '../src/i18n';
import { mountStudio } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

afterEach(async () => {
  await i18next.changeLanguage('en');
});

const mount = (permissions: readonly string[], at = '/overview') =>
  mountStudio({ at, permissions, screen: <CommandPalette /> });

const listed = () =>
  within(screen.getByTestId('command-palette'))
    .queryAllByTestId('palette-item')
    .map((item) => item.getAttribute('data-path'));

describe('the command palette', () => {
  it('opens with Ctrl+K, with the search box focused and only the pages this person can open', async () => {
    const user = userEvent.setup();
    await mount(presetPermissions('agent'));
    expect(screen.queryByTestId('command-palette')).toBeNull();

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Go to a page' });
    expect(within(dialog).getByRole('combobox')).toBe(document.activeElement);
    const paths = listed();
    expect(paths).toEqual(expect.arrayContaining(['/overview', '/inbox', '/visitors', '/account']));
    // A support agent cannot open these, so they are not offered.
    expect(paths).not.toContain('/models');
    expect(paths).not.toContain('/stop-ai');
    expect(paths).not.toContain('/brands');
    // The page being shown says so.
    const home = within(dialog)
      .getAllByTestId('palette-item')
      .find((item) => item.getAttribute('data-path') === '/overview');
    expect(home?.textContent).toContain('You are here');
  });

  it('narrows the list as you type, and Enter opens the chosen page', async () => {
    const user = userEvent.setup();
    const { router } = await mount(presetPermissions('owner'));
    await user.click(screen.getByRole('button', { name: 'Search pages' }));
    await user.keyboard('billing');
    expect(listed()).toEqual(['/settings/billing']);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/billing'));
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('finds a page by its group’s name, and says so when nothing matches', async () => {
    const user = userEvent.setup();
    await mount(presetPermissions('owner'));
    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('settings');
    // Every Settings page, and nothing from other groups.
    expect(listed()).toEqual(
      expect.arrayContaining(['/brands', '/channels', '/team', '/settings/billing']),
    );
    expect(listed()).not.toContain('/knowledge');
    expect(listed()).not.toContain('/inbox');

    await user.clear(screen.getByRole('combobox'));
    await user.keyboard('zzqx');
    expect(listed()).toEqual([]);
    expect(screen.getByTestId('command-palette').textContent).toContain('No page matches “zzqx”.');
  });

  it('closes with Esc and gives focus back to the button that opened it', async () => {
    const user = userEvent.setup();
    const { router } = await mount(presetPermissions('owner'));
    const button = screen.getByRole('button', { name: 'Search pages' });
    await user.click(button);
    expect(await screen.findByTestId('command-palette')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
    expect(document.activeElement).toBe(button);
    expect(router.state.location.pathname).toBe('/overview');

    // The search starts over the next time.
    await user.click(button);
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
  });

  it('pressing the shortcut again closes it', async () => {
    const user = userEvent.setup();
    await mount(presetPermissions('owner'));
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByTestId('command-palette')).toBeTruthy();
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
  });

  it('leaves another open dialog alone', async () => {
    const user = userEvent.setup();
    await mount(presetPermissions('owner'));
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    document.body.append(other);
    try {
      await user.keyboard('{Control>}k{/Control}');
      expect(screen.queryByTestId('command-palette')).toBeNull();
    } finally {
      other.remove();
    }
  });

  it('in Arabic, finds pages by their Arabic name and by their English one', async () => {
    await i18next.changeLanguage('ar');
    const user = userEvent.setup();
    const { router } = await mount(presetPermissions('owner'));
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByTestId('command-palette');
    await user.keyboard('المعرفة');
    expect(listed()).toContain('/knowledge');

    await user.clear(screen.getByRole('combobox'));
    await user.keyboard('visitors');
    expect(listed()).toContain('/visitors');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/visitors'));
  });
});
