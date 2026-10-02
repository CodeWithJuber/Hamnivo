import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ActionsApi, HamnivoApiError, HamnivoClient, MemoryStorage } from '../src/index.js';

const API = 'https://api.test';
const CONV = 'conv_01j9zk7w3xq8r4t2v6m5n1p0ce';
const ACTION = 'act_01j9zk7w3xq8r4t2v6m5n1p0cf';
const HASH = 'a'.repeat(64);
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function api() {
  server.use(
    http.post(`${API}/v1/widget/sessions`, () =>
      HttpResponse.json(
        {
          accessToken: 'access',
          accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          refreshToken: 'ses_x.refresh',
          principal: { id: 'cus_1', verified: false, displayName: null },
          config: {},
          conversations: [],
        },
        { status: 201 },
      ),
    ),
  );
  const client = new HamnivoClient({
    apiBase: API,
    widgetId: 'wid_test',
    storage: new MemoryStorage(),
  });
  return new ActionsApi(client);
}

describe('action approvals', () => {
  it('reads the live request and sends the decision with the card’s hash', async () => {
    const seen: unknown[] = [];
    server.use(
      http.get(`${API}/v1/widget/conversations/${CONV}/actions/${ACTION}`, ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer access');
        return HttpResponse.json({ id: ACTION, state: 'awaiting_approval', argumentsHash: HASH });
      }),
      http.post(
        `${API}/v1/widget/conversations/${CONV}/actions/${ACTION}/decision`,
        async ({ request }) => {
          seen.push(await request.json());
          return HttpResponse.json({ id: ACTION, state: 'approved', argumentsHash: HASH });
        },
      ),
    );
    const actions = api();
    expect((await actions.getAction(CONV, ACTION)).state).toBe('awaiting_approval');
    const decided = await actions.decide(CONV, ACTION, {
      decision: 'approve',
      argumentsHash: HASH,
      clientRequestId: '0b9c9c2e-4a4f-4d36-8f4a-3c2a1d0e9f11',
    });
    expect(decided.state).toBe('approved');
    expect(seen).toEqual([
      {
        decision: 'approve',
        argumentsHash: HASH,
        clientRequestId: '0b9c9c2e-4a4f-4d36-8f4a-3c2a1d0e9f11',
      },
    ]);
  });

  it('surfaces an identity check and a changed request as typed problems', async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/v1/widget/conversations/${CONV}/actions/${ACTION}/decision`, () => {
        calls += 1;
        return HttpResponse.json(
          calls === 1
            ? {
                type: 'about:blank',
                title: 'Please sign in',
                status: 403,
                code: 'IDENTITY_REQUIRED',
              }
            : { type: 'about:blank', title: 'Changed', status: 409, code: 'APPROVAL_MISMATCH' },
          { status: calls === 1 ? 403 : 409 },
        );
      }),
    );
    const actions = api();
    const input = {
      decision: 'approve' as const,
      argumentsHash: HASH,
      clientRequestId: '0b9c9c2e-4a4f-4d36-8f4a-3c2a1d0e9f11',
    };
    const first = await actions.decide(CONV, ACTION, input).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(HamnivoApiError);
    expect((first as HamnivoApiError).code).toBe('IDENTITY_REQUIRED');
    const second = await actions.decide(CONV, ACTION, input).catch((error: unknown) => error);
    expect((second as HamnivoApiError).code).toBe('APPROVAL_MISMATCH');
  });
});
