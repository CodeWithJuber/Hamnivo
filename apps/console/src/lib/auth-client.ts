import { passkeyClient } from '@better-auth/passkey/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { AUTH_BASE } from './config';

/**
 * Better Auth client for staff sign-in (cookie session). The plugins match the gateway's
 * two-factor and passkey server plugins (apps/gateway/src/identity/auth.factory.ts). A sign-in
 * that needs a code returns `twoFactorRedirect`, which the sign-in forms handle themselves.
 */
export const authClient = createAuthClient({
  baseURL: AUTH_BASE,
  plugins: [twoFactorClient(), passkeyClient()],
});

export type AuthError = { code?: string | undefined; message?: string | undefined; status: number };

/** Browsers that can use a passkey on this page. */
export const passkeysAvailable = () =>
  typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
