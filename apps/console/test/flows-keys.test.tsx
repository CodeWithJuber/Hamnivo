// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';
import { AddConnectionForm } from '../src/pages/models/AddConnectionDialog';
import { AddedBanner } from '../src/pages/models/AddedBanner';
import { ReplaceKeyDialog } from '../src/pages/models/ReplaceKeyDialog';
import { TestKeyDialog } from '../src/pages/models/TestKeyDialog';
import { fakeGateway, mountStudio, settle } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const NOW = '2026-10-01T09:00:00.000Z';

const connection = (patch: Record<string, unknown> = {}) => ({
  id: 'mcn_1',
  provider: 'openai',
  label: 'OpenAI production',
  baseUrl: null,
  keyHint: 'a1b2',
  allowedModels: ['gpt-5.4-mini'],
  status: 'active',
  createdAt: NOW,
  ...patch,
});
const outcome = (kind: string, patch: Record<string, unknown> = {}) => ({
  ok: kind === 'ok',
  kind,
  message: 'plain words',
  modelId: 'gpt-5.4-mini',
  latencyMs: 12,
  testedAt: NOW,
  ...patch,
});
/** What the gateway answers when a provider listed its models. */
const listed = (ids: string[], names: Record<string, string> = {}) => ({
  ok: true,
  kind: 'ok',
  message: '',
  models: ids.map((id) => ({ id, name: names[id] ?? null, deprecated: false })),
  fetchedAt: NOW,
});
type Added = Parameters<typeof AddConnectionForm>[0]['onAdded'];
type Saved = Parameters<Added>[0];

describe('adding an AI key', () => {
  const form = (onAdded: Added = () => undefined) =>
    mountStudio({ permissions: owner, screen: <AddConnectionForm onAdded={onAdded} /> });

  it('stores the key with the recommended model chosen, named after the provider', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections': { status: 201, json: connection() },
    });
    const added = vi.fn();
    await form(added);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('API key'), 'sk-test-key-12345678');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    await waitFor(() => expect(added).toHaveBeenCalled());

    const [call] = gateway.to('POST', '/v1/admin/model-connections');
    expect(call?.body).toEqual({
      provider: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-test-key-12345678',
      allowedModels: [],
    });
    expect(call?.headers['x-hamnivo-tenant']).toBe('tnt_test');
    // The same retry must not make a second key.
    expect(call?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ id: 'mcn_1' }), 'gpt-5.4-mini');
    // The key leaves the page as soon as it is stored.
    await waitFor(() =>
      expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe(''),
    );
  });

  it('starts each provider from its own recommended model', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections': { status: 201, json: connection() },
    });
    await form();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Provider'), 'anthropic');
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('claude-haiku-5-5');
    await user.selectOptions(screen.getByLabelText('Provider'), 'google');
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gemini-3.8-flash');
    await user.type(screen.getByLabelText('API key'), 'a-google-key-123');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    await waitFor(() => expect(gateway.to('POST', '/v1/admin/model-connections')).toHaveLength(1));
    expect(gateway.to('POST', '/v1/admin/model-connections')[0]?.body).toMatchObject({
      provider: 'google',
      label: 'Google Gemini',
    });
  });

  it('lets any model name be typed, listed or not', async () => {
    const added = vi.fn();
    fakeGateway({ 'POST /v1/admin/model-connections': { status: 201, json: connection() } });
    await form(added);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Model'));
    await user.type(screen.getByLabelText('Model'), 'my-fine-tune');
    await user.type(screen.getByLabelText('API key'), 'sk-test-key-12345678');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    await waitFor(() => expect(added).toHaveBeenCalled());
    expect(added.mock.calls[0]?.[1]).toBe('my-fine-tune');
  });

  it('reads the models a pasted key can use, once it stops changing, and lets one be picked', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections/models': {
        json: listed(['claude-opus-5-5', 'claude-haiku-5-5'], {
          'claude-opus-5-5': 'Claude Opus 5.5',
          'claude-haiku-5-5': 'Claude Haiku 5.5',
        }),
      },
    });
    await form();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Provider'), 'anthropic');
    await user.type(screen.getByLabelText('API key'), 'test-anthropic-key-1');
    expect(
      await screen.findByText(
        'Models your key can use: 2. Type to search, or type any other name.',
        undefined,
        { timeout: 3000 },
      ),
    ).toBeTruthy();
    // One request, with the whole key, not one per keystroke.
    const asked = gateway.to('POST', '/v1/admin/model-connections/models');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toEqual({
      source: 'key',
      provider: 'anthropic',
      apiKey: 'test-anthropic-key-1',
    });

    const field = screen.getByLabelText('Model') as HTMLInputElement;
    await user.click(field);
    const list = screen.getByRole('listbox', { name: 'Models' });
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Claude Opus 5.5claude-opus-5-5 · most capable',
      'Claude Haiku 5.5claude-haiku-5-5 · fast, low cost · recommended',
    ]);
    await user.click(within(list).getByRole('option', { name: /Claude Opus 5\.5/ }));
    expect(field.value).toBe('claude-opus-5-5');
    expect(screen.queryByRole('listbox')).toBeNull();

    // The keyboard does the same: typing filters, down moves, Enter picks.
    await user.clear(field);
    await user.type(field, 'haiku');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(field.value).toBe('claude-haiku-5-5');
  });

  it('says why the list could not be read, and still suggests models', async () => {
    fakeGateway({
      'POST /v1/admin/model-connections/models': {
        json: { ok: false, kind: 'wrong_key', message: 'x', models: [], fetchedAt: NOW },
      },
    });
    await form();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('API key'), 'test-openai-key-12');
    expect(
      await screen.findByText(
        'Couldn’t load the models: the key wasn’t accepted. Pick a suggestion or type the name.',
        undefined,
        { timeout: 3000 },
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    await user.click(screen.getByLabelText('Model'));
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(3);
  });

  it('asks for what is missing and sends nothing', async () => {
    const gateway = fakeGateway({});
    await form();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('API key'), 'short');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    expect(await screen.findAllByText(/Enter the API key/)).not.toHaveLength(0);
    expect(gateway.calls).toEqual([]);

    // A server of your own needs its address and a model name.
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai-compatible');
    await user.type(screen.getByLabelText('API key'), 'sk-test-key-12345678');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    expect(await screen.findAllByText('Choose a model, or type its name.')).not.toHaveLength(0);
    expect(screen.getAllByText(/base URL/i).length).toBeGreaterThan(0);
    expect(gateway.calls).toEqual([]);
  });

  it('shows the gateway’s reason next to the field it names', async () => {
    fakeGateway({
      'POST /v1/admin/model-connections': {
        problem: {
          status: 422,
          code: 'VALIDATION_FAILED',
          fields: [{ path: 'apiKey', message: 'That is not a key we can store.' }],
        },
      },
    });
    const added = vi.fn();
    await form(added);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('API key'), 'sk-test-key-12345678');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    expect(await screen.findAllByText('That is not a key we can store.')).not.toHaveLength(0);
    expect(added).not.toHaveBeenCalled();
  });

  it('keeps the key hidden, and out of the page’s text, while typing', async () => {
    fakeGateway({});
    await form();
    const user = userEvent.setup();
    const field = screen.getByLabelText('API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    await user.type(field, 'sk-never-shown-12345678');
    expect(document.body.textContent).not.toContain('sk-never-shown-12345678');
  });
});

describe('a key just saved', () => {
  const banner = (
    onResult?: (result: unknown) => void,
    onReplace: (saved: Saved) => void = () => undefined,
  ) =>
    mountStudio({
      permissions: owner,
      screen: (
        <AddedBanner
          connection={connection() as Saved}
          modelId="gpt-5.4-mini"
          onReplace={onReplace}
          onResult={onResult}
        />
      ),
    });

  it('tests it with the model chosen, as soon as it appears, and says it works', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/test': { json: outcome('ok') },
    });
    const onResult = vi.fn();
    await banner(onResult);
    expect(await screen.findByText('The key works')).toBeTruthy();
    expect(gateway.to('POST', '/v1/admin/model-connections/mcn_1/test')).toHaveLength(1);
    expect(gateway.calls[0]?.body).toEqual({ modelId: 'gpt-5.4-mini' });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    // Nothing to fix, so no way to replace the key from here.
    expect(screen.queryByRole('button', { name: 'Replace key' })).toBeNull();
  });

  it('says in plain words what is wrong, and offers to replace the key', async () => {
    fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/test': { json: outcome('wrong_key') },
    });
    const onReplace = vi.fn();
    await banner(undefined, onReplace);
    expect(await screen.findByText('The key wasn’t accepted')).toBeTruthy();
    expect(screen.getByText(/Check that you copied all of it/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ id: 'mcn_1' }));
  });

  it('tests again when asked, and shows the newest answer', async () => {
    let n = 0;
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/test': () => ({
        json: outcome(++n === 1 ? 'no_credit' : 'ok'),
      }),
    });
    await banner();
    expect(await screen.findByText('No credit left')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Test again' }));
    expect(await screen.findByText('The key works')).toBeTruthy();
    expect(screen.queryByText('No credit left')).toBeNull();
    expect(gateway.to('POST', '/v1/admin/model-connections/mcn_1/test')).toHaveLength(2);
  });

  it('shows why a test could not be run at all, instead of a result', async () => {
    fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/test': {
        problem: { status: 403, code: 'SCOPE_DENIED' },
      },
    });
    await banner();
    expect(await screen.findByTestId('action-error')).toBeTruthy();
    expect(screen.queryByTestId('probe-result')).toBeNull();
  });
});

describe('replacing a key', () => {
  const dialog = (onResult?: (result: unknown) => void) =>
    mountStudio({
      permissions: owner,
      screen: (
        <ReplaceKeyDialog
          connection={connection() as Saved}
          onOpenChange={() => undefined}
          onResult={onResult}
        />
      ),
    });

  it('stores the new key in place, tests it, and never shows it again', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/rotate': {
        json: connection({ keyHint: 'z9y8' }),
      },
      'POST /v1/admin/model-connections/mcn_1/test': { json: outcome('ok') },
    });
    const onResult = vi.fn();
    await dialog(onResult);
    const user = userEvent.setup();
    const field = await screen.findByLabelText('New API key');
    expect((field as HTMLInputElement).type).toBe('password');
    await user.type(field, 'sk-brand-new-key-1234');
    await user.click(screen.getByRole('button', { name: 'Replace and test' }));

    expect(await screen.findByText('The key works')).toBeTruthy();
    const [rotate] = gateway.to('POST', '/v1/admin/model-connections/mcn_1/rotate');
    expect(rotate?.body).toEqual({ apiKey: 'sk-brand-new-key-1234' });
    // The test goes with the connection's own model.
    expect(gateway.to('POST', '/v1/admin/model-connections/mcn_1/test')[0]?.body).toEqual({
      modelId: 'gpt-5.4-mini',
    });
    expect(screen.getByText(/Key replaced\. The new key ends in z9y8\./)).toBeTruthy();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(document.body.textContent).not.toContain('sk-brand-new-key-1234');
    expect(screen.queryByLabelText('New API key')).toBeNull();
  });

  it('asks for a key that is long enough, and sends nothing without one', async () => {
    const gateway = fakeGateway({});
    await dialog();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New API key'), 'short');
    await user.click(screen.getByRole('button', { name: 'Replace and test' }));
    expect(await screen.findAllByText(/Enter the API key/)).not.toHaveLength(0);
    expect(gateway.calls).toEqual([]);
  });

  it('keeps the old key and says why when the gateway refuses', async () => {
    fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/rotate': {
        problem: { status: 403, code: 'SCOPE_DENIED' },
      },
    });
    await dialog();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New API key'), 'sk-brand-new-key-1234');
    await user.click(screen.getByRole('button', { name: 'Replace and test' }));
    expect(await screen.findByTestId('action-error')).toBeTruthy();
    // Nothing was replaced, so there is no result to show and the form is still there.
    expect(screen.queryByTestId('replace-key-done')).toBeNull();
    expect(screen.getByLabelText('New API key')).toBeTruthy();
  });
});

describe('testing a key from the list', () => {
  it('tests it as soon as the window opens, with the model it was saved for', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/test': { json: outcome('no_credit') },
    });
    await mountStudio({
      permissions: owner,
      screen: <TestKeyDialog connection={connection() as Saved} onOpenChange={() => undefined} />,
    });
    expect(await screen.findByText('No credit left')).toBeTruthy();
    expect(gateway.to('POST', '/v1/admin/model-connections/mcn_1/test')[0]?.body).toEqual({
      modelId: 'gpt-5.4-mini',
    });
    const box = screen.getByTestId('test-key-dialog-body');
    expect(within(box).getByText('Tested with', { exact: false })).toBeTruthy();
  });

  it('tests another model when one is chosen and the test is repeated', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/test': () => ({ json: outcome('ok') }),
      'POST /v1/admin/model-connections/models': { json: listed(['gpt-5.5', 'gpt-5.4-mini']) },
    });
    await mountStudio({
      permissions: owner,
      screen: <TestKeyDialog connection={connection() as Saved} onOpenChange={() => undefined} />,
    });
    await screen.findByText('The key works');
    // The connection's own models, read through the gateway with its saved key.
    expect(
      await screen.findByText(
        'Models your key can use: 2. Type to search, or type any other name.',
      ),
    ).toBeTruthy();
    expect(gateway.to('POST', '/v1/admin/model-connections/models')[0]?.body).toEqual({
      source: 'connection',
      connectionId: 'mcn_1',
    });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Model'));
    await user.click(screen.getByRole('option', { name: /gpt-5\.5/ }));
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gpt-5.5');
    await user.click(screen.getByRole('button', { name: 'Test again' }));
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/admin/model-connections/mcn_1/test')).toHaveLength(2),
    );
    expect(gateway.to('POST', '/v1/admin/model-connections/mcn_1/test')[1]?.body).toEqual({
      modelId: 'gpt-5.5',
    });
  });

  it('waits for a model to be typed when a server of your own has none to start from', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/test': { json: outcome('ok') },
    });
    await mountStudio({
      permissions: owner,
      screen: (
        <TestKeyDialog
          connection={connection({ provider: 'openai-compatible', allowedModels: [] }) as Saved}
          onOpenChange={() => undefined}
        />
      ),
    });
    await settle();
    const tests = () => gateway.to('POST', '/v1/admin/model-connections/mcn_1/test');
    expect(tests()).toEqual([]);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Model'), 'llama-3');
    await user.click(screen.getByRole('button', { name: 'Test again' }));
    await waitFor(() => expect(tests()).toHaveLength(1));
    expect(tests()[0]?.body).toEqual({ modelId: 'llama-3' });
  });
});
