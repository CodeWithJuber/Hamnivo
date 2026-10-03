import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AuthFields,
  addressError,
  authBody,
  authErrors,
  emptyAuth,
  isolate,
  refusedPaths,
  ServiceFields,
} from '../src/components/tools/HttpToolForms';
import { HttpToolSources } from '../src/components/tools/HttpToolSources';
import { initI18n } from '../src/i18n';
import type { HttpToolEndpoint, HttpToolSource } from '../src/lib/ai-power';
import { ApiError } from '../src/lib/api';
import {
  blankDraft,
  draftErrors,
  draftOf,
  endpointBody,
  missingPlaceholders,
  newArgument,
  pathArgument,
  placeholdersOf,
} from '../src/lib/http-tools';
import { renderStudio, textOf } from './render';

let t: Awaited<ReturnType<typeof initI18n>>['t'];

beforeAll(async () => {
  t = (await initI18n('en')).t;
});

const MANAGER = ['tools.read', 'tools.manage'];

function endpoint(overrides: Partial<HttpToolEndpoint> = {}): HttpToolEndpoint {
  return {
    toolId: 'tool_1',
    toolName: 'look_up_an_order',
    title: 'Look up an order',
    description: 'Finds an order by its number.',
    method: 'GET',
    path: '/orders/{orderId}',
    risk: 'read',
    status: 'review',
    revision: 1,
    editable: true,
    arguments: [
      {
        name: 'orderId',
        in: 'path',
        key: 'orderId',
        required: true,
        type: 'string',
        description: 'The order number',
      },
    ],
    ...overrides,
  };
}

function source(overrides: Partial<HttpToolSource> = {}): HttpToolSource {
  return {
    id: 'hsrc_1',
    brandId: 'brd_1',
    name: 'Order system',
    kind: 'manual',
    baseUrl: 'https://api.noor.example/v1',
    auth: { kind: 'bearer', header: 'Authorization', masked: '••••a1b2' },
    specTitle: null,
    specVersion: null,
    status: 'active',
    endpoints: [endpoint()],
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

const sources = (list: HttpToolSource[], permissions: readonly string[] = MANAGER) =>
  renderStudio({
    at: '/tools',
    permissions,
    screen: (
      <AnnouncerProvider>
        <HttpToolSources
          sources={list}
          manage={permissions.includes('tools.manage')}
          onOpenTool={() => undefined}
        />
      </AnnouncerProvider>
    ),
  });

describe('a request as a person writes it', () => {
  it('sends what was typed, trimmed, and only what says something', () => {
    const body = endpointBody({
      ...blankDraft(),
      title: '  Look up an order ',
      about: ' Finds an order. ',
      method: 'GET',
      path: ' /orders/{orderId} ',
      args: [
        newArgument({ name: 'orderId', place: 'path', required: false, about: ' The number ' }),
        newArgument({ name: 'lang', place: 'query', key: ' language ' }),
        newArgument({ name: 'same', place: 'query', key: 'same' }),
        newArgument({
          name: 'trace',
          place: 'header',
          key: 'X-Trace',
          type: 'integer',
          required: true,
        }),
      ],
    });
    expect(body).toEqual({
      title: 'Look up an order',
      description: 'Finds an order.',
      method: 'GET',
      path: '/orders/{orderId}',
      arguments: [
        // A value in the path is always needed, whatever the box said.
        { name: 'orderId', in: 'path', type: 'string', required: true, description: 'The number' },
        { name: 'lang', in: 'query', key: 'language', type: 'string', required: false },
        { name: 'same', in: 'query', type: 'string', required: false },
        { name: 'trace', in: 'header', key: 'X-Trace', type: 'integer', required: true },
      ],
    });
    expect('risk' in body).toBe(false);
    expect(
      endpointBody({ ...blankDraft(), title: 'x', about: 'y', path: '/z', risk: 'money' }).risk,
    ).toBe('money');
  });

  it('starts from a request that is there, so a change sends it back the same', () => {
    const stored = endpoint({
      method: 'POST',
      path: '/orders/{orderId}/notes',
      risk: 'write',
      arguments: [
        {
          name: 'orderId',
          in: 'path',
          key: 'orderId',
          required: true,
          type: 'string',
          description: null,
        },
        {
          name: 'text',
          in: 'body',
          key: 'note.text',
          required: true,
          type: 'string',
          description: 'The note',
        },
        {
          name: 'pinned',
          in: 'body',
          key: 'pinned',
          required: false,
          type: 'boolean',
          description: null,
        },
        {
          name: 'tags',
          in: 'query',
          key: 'tags',
          required: false,
          type: 'array',
          description: null,
        },
      ],
    });
    const draft = draftOf(stored);
    expect(draft).toMatchObject({ title: 'Look up an order', method: 'POST', risk: 'write' });
    expect(draft.args.map((a) => [a.name, a.place, a.key, a.type, a.required])).toEqual([
      ['orderId', 'path', '', 'string', true],
      ['text', 'body', 'note.text', 'string', true],
      ['pinned', 'body', '', 'boolean', false],
      // A kind the form cannot write becomes text rather than being lost.
      ['tags', 'query', '', 'string', false],
    ]);
    expect(endpointBody(draft)).toMatchObject({
      method: 'POST',
      path: '/orders/{orderId}/notes',
      risk: 'write',
      arguments: [
        { name: 'orderId', in: 'path', required: true },
        { name: 'text', in: 'body', key: 'note.text', required: true, description: 'The note' },
        { name: 'pinned', in: 'body', type: 'boolean' },
        { name: 'tags', in: 'query' },
      ],
    });
    // Every detail has its own identity for the list.
    expect(new Set(draft.args.map((a) => a.uid)).size).toBe(4);
  });

  it('says what is wrong before anything is sent', () => {
    expect(Object.keys(draftErrors(blankDraft(), t)).sort()).toEqual([
      'ep-about',
      'ep-path',
      'ep-title',
    ]);
    const bad = newArgument({ name: '1st' });
    const a = newArgument({ name: 'a' });
    const again = newArgument({ name: 'a' });
    const errors = draftErrors(
      { ...blankDraft(), title: 'x', about: 'y', path: '/z', args: [bad, a, again] },
      t,
    );
    expect(errors).toEqual({
      [`ep-arg-${bad.uid}-name`]: 'Use letters, digits and underscores, starting with a letter.',
      [`ep-arg-${again.uid}-name`]: 'Two details have the same name.',
    });
    expect(draftErrors({ ...blankDraft(), title: 'x', about: 'y', path: 'orders' }, t)).toEqual({
      'ep-path': 'Start the path with /.',
    });
  });

  it('finds the parts of the path that nothing fills in, and starts a detail for each', () => {
    expect(placeholdersOf('/orders/{orderId}/items/{itemId}/{orderId}')).toEqual([
      'orderId',
      'itemId',
    ]);
    expect(placeholdersOf('/orders')).toEqual([]);
    const draft = {
      ...blankDraft(),
      path: '/orders/{orderId}/items/{item-id}',
      args: [
        newArgument({ name: 'orderId', place: 'path' }),
        newArgument({ name: 'x', place: 'query', key: 'item-id' }),
      ],
    };
    // A query detail called `item-id` does not fill a place in the path.
    expect(missingPlaceholders(draft)).toEqual(['item-id']);
    expect(pathArgument('orderId')).toMatchObject({
      name: 'orderId',
      key: '',
      place: 'path',
      required: true,
    });
    // A name an argument cannot have is typed by the person, and the request name is kept.
    expect(pathArgument('item-id')).toMatchObject({ name: '', key: 'item-id', place: 'path' });
    expect(
      missingPlaceholders({ ...draft, args: [...draft.args, pathArgument('item-id')] }),
    ).toEqual([]);
  });
});

describe('the credential of a service', () => {
  it('sends what the kind needs and nothing else', () => {
    expect(authBody(emptyAuth())).toEqual({ kind: 'none' });
    expect(
      authBody({ ...emptyAuth(), kind: 'bearer', token: ' abc12345 ', value: 'ignored' }),
    ).toEqual({
      kind: 'bearer',
      token: 'abc12345',
    });
    expect(
      authBody({
        ...emptyAuth(),
        kind: 'header',
        header: ' X-Api-Key ',
        value: ' secret ',
        token: 'x',
      }),
    ).toEqual({ kind: 'header', header: 'X-Api-Key', value: 'secret' });
  });

  it('checks the credential and the address as the gateway will', () => {
    expect(authErrors({ ...emptyAuth(), kind: 'bearer', token: 'short' }, 'svc-auth', t)).toEqual({
      'svc-auth-token': 'The token has at least 8 characters.',
    });
    expect(
      authErrors(
        { ...emptyAuth(), kind: 'header', header: 'Bad Header', value: '' },
        'svc-auth',
        t,
      ),
    ).toEqual({
      'svc-auth-header': 'Use letters, digits, hyphens and underscores.',
      'svc-auth-value': 'Enter the secret value.',
    });
    expect(authErrors(emptyAuth(), 'svc-auth', t)).toEqual({});
    expect(addressError('https://api.example.com/v1', 'svc', t)).toEqual({});
    expect(addressError('api.example.com', 'svc', t)).toEqual({
      'svc-baseUrl': 'Enter the address, starting with https://.',
    });
  });

  it('turns what the gateway refused into a message for each field', () => {
    const refusal = new ApiError(422, 'VALIDATION_FAILED', {
      code: 'VALIDATION_FAILED',
      status: 422,
      fields: [
        { path: 'endpoint.path', message: 'Bad path' },
        { path: 'endpoint.arguments.2.name', message: 'Bad name' },
        { path: 'endpoint.arguments', message: 'Second message' },
        { path: 'auth.header', message: 'Bad header' },
        { path: 'baseUrl', message: 'Bad address' },
        { path: 'openapi.operations', message: 'Nothing to add' },
      ],
    } as never);
    expect(refusedPaths(refusal)).toEqual({
      path: 'Bad path',
      arguments: 'Bad name',
      auth: 'Bad header',
      baseUrl: 'Bad address',
      'openapi.operations': 'Nothing to add',
    });
    expect(refusedPaths(new Error('x'))).toEqual({});
    expect(refusedPaths(new ApiError(409, 'VERSION_CONFLICT', null))).toEqual({});
    expect(isolate('Ünïcode')).toBe('⁨Ünïcode⁩');
  });

  it('offers the kinds of credential it is asked to, and the fields of the one chosen', async () => {
    const draft = { ...emptyAuth(), kind: 'header' as const };
    const html = await renderStudio({
      at: '/tools',
      permissions: MANAGER,
      screen: <AuthFields id="a" auth={draft} onChange={() => undefined} errors={{}} />,
    });
    const text = textOf(html);
    for (const label of [
      'No credential',
      'A token',
      'A secret in a header',
      'Header name',
      'Secret value',
    ]) {
      expect(text).toContain(label);
    }
    expect(html).toContain('type="password"');
    const limited = await renderStudio({
      at: '/tools',
      permissions: MANAGER,
      screen: (
        <AuthFields
          id="a"
          auth={{ ...emptyAuth(), kind: 'bearer' }}
          onChange={() => undefined}
          errors={{ 'a-token': 'Too short' }}
          kinds={['bearer', 'header']}
        />
      ),
    });
    expect(textOf(limited)).not.toContain('No credential');
    expect(textOf(limited)).toContain('Too short');
    const service = await renderStudio({
      at: '/tools',
      permissions: MANAGER,
      screen: (
        <ServiceFields
          id="svc"
          name="Order system"
          baseUrl="https://api.example.com/v1"
          auth={emptyAuth()}
          onName={() => undefined}
          onBaseUrl={() => undefined}
          onAuth={() => undefined}
          errors={{ 'svc-baseUrl': 'Enter the address.' }}
        />
      ),
    });
    expect(textOf(service)).toContain('Name of the service');
    expect(textOf(service)).toContain('Address of the service');
    expect(textOf(service)).toContain('Enter the address.');
    expect(service).toContain('value="https://api.example.com/v1"');
  });
});

describe('the services in Studio', () => {
  it('shows each service with its address, how it signs in and its tools', async () => {
    const html = await sources([
      source({
        endpoints: [
          endpoint(),
          endpoint({
            toolId: 'tool_2',
            toolName: 'add_note',
            title: 'Add a note',
            method: 'POST',
            path: '/orders/{orderId}/notes',
            risk: 'write',
            status: 'enabled',
            editable: false,
          }),
        ],
      }),
    ]);
    const text = textOf(html);
    expect(html).toContain('data-testid="http-sources"');
    expect(text).toContain('Order system');
    expect(text).toContain('api.noor.example');
    expect(text).toContain('Written by hand');
    expect(text).toContain('Tools: 2');
    expect(text).toContain('Waiting for review: 1');
    expect(text).toContain('Token ••••a1b2');
    expect(text).toContain('GET');
    expect(text).toContain('/orders/{orderId}');
    expect(text).toContain('Look up an order');
    expect(text).toContain('POST');
    expect(text).toContain('Add a note');
    expect(text).toContain('Waiting for review');
    expect(text).toContain('On');
    // The credential is never shown beyond its last characters.
    expect(html).not.toContain('Bearer');
  });

  it('lets only people who manage tools change a service, and only a request written by hand', async () => {
    const list = [
      source({
        endpoints: [
          endpoint(),
          endpoint({ toolId: 'tool_2', title: 'Imported one', editable: false }),
        ],
      }),
    ];
    const manager = await sources(list);
    expect(manager).toContain('data-testid="add-request"');
    expect(manager).toContain('aria-label="Edit Order system"');
    expect(manager).toContain('aria-label="Remove Order system"');
    expect(manager.match(/data-testid="edit-request"/g)).toHaveLength(1);
    expect(manager).toContain('aria-label="Edit the request Look up an order"');
    expect(textOf(manager)).toContain('Imported: import it again to change it.');
    expect(textOf(manager)).toContain('Import more');
    const reader = await sources(list, ['tools.read']);
    expect(reader).not.toContain('add-request');
    expect(reader).not.toContain('edit-http-source');
    expect(reader).not.toContain('remove-http-source');
    expect(reader).not.toContain('edit-request');
    expect(textOf(reader)).toContain('Look up an order');
    // Anyone who can read can open a tool to see its settings.
    expect(reader).toContain('aria-label="Open the tool Look up an order"');
  });

  it('says when a service is off, or has no credential, or was imported', async () => {
    const html = await sources([
      source({
        status: 'disabled',
        kind: 'openapi',
        auth: { kind: 'none', header: null, masked: null },
        specTitle: 'Noor Orders',
        specVersion: '1.2.0',
      }),
    ]);
    const text = textOf(html);
    expect(text).toContain('Off');
    expect(text).toContain('This service is off, so its tools cannot run.');
    expect(text).toContain('No credential');
    expect(text).toContain('Imported description');
    expect(text).toContain('Noor Orders');
    expect(text).toContain('1.2.0');
    expect(text).toContain('Turn on');
    // Nothing is added to a service that is off.
    expect(html.match(/<button\b[^>]*data-testid="add-request"[^>]*>/)?.[0]).toContain('disabled');
    const keyed = await sources([
      source({ auth: { kind: 'header', header: 'X-Api-Key', masked: '••••zz99' } }),
    ]);
    expect(textOf(keyed)).toContain('Secret in the X-Api-Key header ••••zz99');
  });

  it('shows what an imported description says as text, in its own direction', async () => {
    const hostile = '<img src=x onerror=alert(1)> عنوان';
    const html = await sources([
      source({
        name: hostile,
        specTitle: hostile,
        specVersion: '1',
        endpoints: [endpoint({ title: hostile })],
      }),
    ]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toMatch(/<bdi[^>]*>&lt;img/);
  });
});
