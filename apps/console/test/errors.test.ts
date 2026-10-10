import { describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { ApiError } from '../src/lib/api';
import { describeError } from '../src/lib/errors';

describe('an error Studio has no words of its own for', () => {
  it('says a service is not responding when the proxy answers 502, 503 or 504', async () => {
    const i18n = await initI18n('en');
    for (const status of [502, 503, 504]) {
      const text = describeError(i18n.t, new ApiError(status, 'UNKNOWN' as never, null));
      expect(text.title, String(status)).toBe('A connected service isn’t responding');
      expect(text.description).toBe('Nothing was changed. Try again in a moment.');
    }
  });

  it('owns any other server failure, and stays general otherwise', async () => {
    const i18n = await initI18n('en');
    expect(describeError(i18n.t, new ApiError(500, 'UNKNOWN' as never, null)).title).toBe(
      'Something went wrong on our side',
    );
    expect(describeError(i18n.t, new ApiError(418, 'UNKNOWN' as never, null)).title).toBe(
      'Something went wrong',
    );
    // A code Studio knows keeps its own words whatever the status.
    expect(describeError(i18n.t, new ApiError(503, 'RATE_LIMITED', null)).title).toBe(
      'Too many requests',
    );
  });
});
