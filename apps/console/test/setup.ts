import { configure } from '@testing-library/dom';
import { vi } from 'vitest';

// findBy… and waitFor give up after 1 s by default. On the shared CI runner, while turbo tests
// every package at once, a screen's first render took up to 2.5 times as long as on a quiet run,
// and the AI draft card missed that second (2026-11-21). As with testTimeout (vitest.config.ts),
// the wait is for CPU contention; the assertions are unchanged.
configure({ asyncUtilTimeout: 5_000 });

// Tests run in Node, with no page around them. These two modules read the page's <meta> tags and
// location when they load, so screens rendered here get fixed values instead.
vi.mock('../src/lib/config', () => ({
  API_BASE: '',
  GATEWAY_ORIGIN: 'http://localhost:4000',
  WIDGET_ORIGIN: 'http://localhost:5174',
  AUTH_BASE: 'http://localhost/api/auth',
}));
vi.mock('../src/lib/auth-client', () => ({
  authClient: { signOut: async () => ({}) },
  passkeysAvailable: () => false,
}));
