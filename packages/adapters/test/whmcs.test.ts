import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EgressError, safeRequest } from '../src/net/index.js';
import { callWhmcs, WHMCS_ACTIONS } from '../src/whmcs/index.js';

vi.mock('../src/net/index.js', async (original) => ({
  ...(await original<typeof import('../src/net/index.js')>()),
  safeRequest: vi.fn(),
}));
const request = {
  baseUrl: 'https://billing.example.com/',
  credentials: { identifier: 'identifier', secret: 'secret' },
  policy: {},
  action: 'GetInvoices' as const,
};
beforeEach(() => vi.clearAllMocks());
describe('guarded WHMCS API', () => {
  it('posts credentials only to the fixed API path', async () => {
    vi.mocked(safeRequest).mockResolvedValue({
      status: 200,
      body: Buffer.from('{"result":"success"}'),
      truncated: false,
      headers: {},
      durationMs: 1,
      url: request.baseUrl,
    });
    await callWhmcs({ ...request, fields: { clientid: 7 } });
    const input = vi.mocked(safeRequest).mock.calls[0]![0];
    expect(input.url).toBe('https://billing.example.com/includes/api.php');
    const body = new URLSearchParams(String(input.body));
    expect(body.get('clientid')).toBe('7');
    expect(body.get('identifier')).toBe('identifier');
    expect(body.get('secret')).toBe('secret');
    expect(body.has('username')).toBe(false);
    expect(body.has('password')).toBe(false);
  });
  it('never accepts injected API verbs or authentication fields', async () => {
    await expect(
      callWhmcs({ ...request, fields: { action: 'RefundTransaction' } }),
    ).rejects.toMatchObject({ mayHaveApplied: false });
    expect(safeRequest).not.toHaveBeenCalled();
    expect(WHMCS_ACTIONS).not.toContain('RefundTransaction');
  });
  it('marks ambiguous write responses unknown and read-only calculation safe', async () => {
    vi.mocked(safeRequest).mockRejectedValue(new EgressError('timeout', 'timeout'));
    await expect(callWhmcs({ ...request, action: 'OpenTicket' })).rejects.toMatchObject({
      kind: 'timeout',
      mayHaveApplied: true,
    });
    await expect(
      callWhmcs({ ...request, action: 'UpgradeProduct', fields: { calconly: true } }),
    ).rejects.toMatchObject({ mayHaveApplied: false });
  });
  it('does not expose API error bodies or secrets', async () => {
    vi.mocked(safeRequest).mockResolvedValue({
      status: 200,
      body: Buffer.from('{"result":"error","message":"secret internal details"}'),
      truncated: false,
      headers: {},
      durationMs: 1,
      url: request.baseUrl,
    });
    await expect(callWhmcs({ ...request, action: 'OpenTicket' })).rejects.toMatchObject({
      message: 'The WHMCS request could not be confirmed.',
      mayHaveApplied: false,
    });
  });
  it('marks malformed or truncated responses to writes unknown', async () => {
    vi.mocked(safeRequest).mockResolvedValue({
      status: 200,
      body: Buffer.from('{'),
      truncated: false,
      headers: {},
      durationMs: 1,
      url: request.baseUrl,
    });
    await expect(callWhmcs({ ...request, action: 'AddTicketReply' })).rejects.toMatchObject({
      mayHaveApplied: true,
    });
  });
  it.each([{}, { result: 'pending' }, { status: 'success' }, { result: null }, { result: true }])(
    'keeps an unrecognized JSON envelope unknown for writes: %j',
    async (envelope) => {
      vi.mocked(safeRequest).mockResolvedValue({
        status: 200,
        body: Buffer.from(JSON.stringify(envelope)),
        truncated: false,
        headers: {},
        durationMs: 1,
        url: request.baseUrl,
      });
      await expect(callWhmcs({ ...request, action: 'OpenTicket' })).rejects.toMatchObject({
        kind: 'response',
        mayHaveApplied: true,
      });
      await expect(callWhmcs(request)).rejects.toMatchObject({
        kind: 'response',
        mayHaveApplied: false,
      });
    },
  );
  it.each(['identifier', 'secret', 'username', 'password'])(
    'rejects overridden credential field %s',
    async (field) => {
      await expect(
        callWhmcs({ ...request, fields: { [field]: 'override' } }),
      ).rejects.toMatchObject({ mayHaveApplied: false });
      expect(safeRequest).not.toHaveBeenCalled();
    },
  );
});
