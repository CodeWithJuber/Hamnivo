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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// A fresh module per test (whether tracking is on is decided once per page), and the ApiError
// class of that same fresh module graph.
const fresh = async () => {
  vi.resetModules();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  const reporting = await import('../src/lib/error-reporting');
  const { ApiError } = await import('../src/lib/api');
  return { ...reporting, ApiError };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        dsn: 'https://key@errors.example.com/42',
        environment: 'test',
        release: null,
      }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Studio reporting its errors', () => {
  it('sends a fault through the API tunnel, tagged as Studio', async () => {
    const { watchErrors, reportError } = await fresh();
    watchErrors('https://api.example.com');
    const error = new Error('the page broke');
    reportError(error);
    await settle();
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/v1/error-reporting');
    expect(sdk.init.mock.calls[0]?.[0]).toMatchObject({
      tunnel: 'https://api.example.com/v1/error-reports',
      defaultIntegrations: false,
      initialScope: { tags: { app: 'studio' } },
    });
    expect(sdk.captureException).toHaveBeenCalledWith(error);
  });

  it('does not send an answer the API gave on purpose, but does send a server fault', async () => {
    const { reportError, ApiError } = await fresh();
    reportError(new ApiError(403, 'SCOPE_DENIED', null));
    reportError(new ApiError(404, 'NOT_FOUND', null));
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    const fault = new ApiError(500, 'INTERNAL', null);
    reportError(fault);
    await settle();
    expect(sdk.captureException).toHaveBeenCalledWith(fault);
  });
});
