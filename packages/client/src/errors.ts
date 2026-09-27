/** An RFC 9457 problem returned by the Hamnivo API (or a network failure, status 0). */
export class HamnivoApiError extends Error {
  override name = 'HamnivoApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null,
    readonly problem: Record<string, unknown> = {},
  ) {
    super(typeof problem.detail === 'string' ? problem.detail : `${code} (${status})`);
  }

  static network(error: unknown): HamnivoApiError {
    return new HamnivoApiError(0, 'NETWORK', true, null, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function problemOf(response: Response): Promise<HamnivoApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Not a problem document (proxy error page, empty body).
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  const code = typeof body.code === 'string' ? body.code : `HTTP_${response.status}`;
  const retryable =
    typeof body.retryable === 'boolean'
      ? body.retryable
      : response.status === 429 || response.status >= 500;
  return new HamnivoApiError(
    response.status,
    code,
    retryable,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    body,
  );
}
