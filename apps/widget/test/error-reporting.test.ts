import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  eventFiltersIntegration: vi.fn(() => ({ name: 'EventFilters' })),
  functionToStringIntegration: vi.fn(() => ({ name: 'FunctionToString' })),
  linkedErrorsIntegration: vi.fn(() => ({ name: 'LinkedErrors' })),
  dedupeIntegration: vi.fn(() => ({ name: 'Dedupe' })),
  httpContextIntegration: vi.fn(() => ({ name: 'HttpContext' })),
}));
vi.mock('@sentry/browser', () => sdk);

const settings = (dsn: string | null) =>
  vi.fn(async () => Response.json({ dsn, environment: 'production', release: 'abc123' }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Each test starts with a fresh module: whether tracking is on is decided once per page.
const fresh = async () => {
  vi.resetModules();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  return import('../src/error-reporting.js');
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the chat reporting its errors', () => {
  it('asks the API once, and downloads nothing when tracking is off', async () => {
    const fetch = settings(null);
    vi.stubGlobal('fetch', fetch);
    const { watchErrors, reportError } = await fresh();
    watchErrors('https://api.example.com/');
    reportError(new Error('one'));
    reportError(new Error('two'));
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/v1/widget/error-reporting');
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it('sends through the API tunnel, without breadcrumbs or personal data', async () => {
    vi.stubGlobal('fetch', settings('https://key@errors.example.com/42'));
    const { watchErrors, reportError } = await fresh();
    watchErrors('https://api.example.com');
    const error = new Error('boom');
    reportError(error);
    await settle();
    expect(sdk.init).toHaveBeenCalledOnce();
    const options = sdk.init.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      dsn: 'https://key@errors.example.com/42',
      tunnel: 'https://api.example.com/v1/widget/error-reports',
      release: 'abc123',
      defaultIntegrations: false,
      dataCollection: { userInfo: false, cookies: false, urlQueryParams: false },
      initialScope: { tags: { app: 'widget' } },
    });
    expect(options.beforeSend({ request: { url: 'https://chat.example/?host=a.com#x' } })).toEqual({
      request: { url: 'https://chat.example/' },
    });
    expect(sdk.captureException).toHaveBeenCalledWith(error);
  });

  it('keeps the chat working when the API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { reportError } = await fresh();
    expect(() => reportError(new Error('boom'))).not.toThrow();
    await settle();
    expect(warn).toHaveBeenCalledOnce();
    expect(sdk.captureException).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('listens for errors nothing caught, and ignores other origins’ "Script error."', async () => {
    vi.stubGlobal('fetch', settings('https://key@errors.example.com/42'));
    const { watchErrors } = await fresh();
    watchErrors('https://api.example.com');
    const listeners = new Map(
      vi
        .mocked(window.addEventListener)
        .mock.calls.map(([name, fn]) => [name, fn as (e: unknown) => void]),
    );
    listeners.get('error')?.({ error: null, message: 'Script error.' });
    await settle();
    expect(sdk.captureException).not.toHaveBeenCalled();
    const thrown = new Error('render failed');
    listeners.get('error')?.({ error: thrown });
    listeners.get('unhandledrejection')?.({ reason: 'rejected' });
    await settle();
    expect(sdk.captureException.mock.calls.map(([e]) => e)).toEqual([thrown, 'rejected']);
  });
});
