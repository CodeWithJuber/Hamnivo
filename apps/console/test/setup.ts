import { vi } from 'vitest';

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
