/**
 * A real OpenID Connect provider (oidc-provider) for the single sign-on journey, started by the
 * e2e stack. Its built-in login page accepts any password; the login name is the person's email
 * address, which the provider asserts as verified. Consent is implied for the Studio client.
 * Plain erasable TypeScript: the stack runs it with Node's type stripping.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Provider from 'oidc-provider';

export interface E2eIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  close(): Promise<void>;
}

const displayName = (email: string) =>
  (email.split('@')[0] ?? email).replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export async function startE2eIdp(port: number, redirectPrefix: string): Promise<E2eIdp> {
  const issuer = `http://127.0.0.1:${port}`;
  const clientId = 'hamnivo-studio-e2e';
  const clientSecret = randomBytes(24).toString('base64url');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...privateKey.export({ format: 'jwk' }), kid: 'e2e-idp', alg: 'RS256', use: 'sig' };
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [`${redirectPrefix}placeholder`],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    jwks: { keys: [key] },
    cookies: { keys: [randomBytes(16).toString('hex')] },
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'] },
    features: { devInteractions: { enabled: true } },
    pkce: { required: () => true },
    async findAccount(_ctx, sub) {
      const email = sub.trim().toLowerCase();
      return {
        accountId: sub,
        claims: async () => ({
          sub,
          email,
          // A login starting with "unverified." stands for an address the provider never checked.
          email_verified: !email.startsWith('unverified.'),
          name: displayName(email),
        }),
      };
    },
    async loadExistingGrant(ctx) {
      const accountId = ctx.oidc.session?.accountId;
      const client = ctx.oidc.client;
      if (!accountId || !client) return undefined;
      const grant = new ctx.oidc.provider.Grant({ clientId: client.clientId, accountId });
      grant.addOIDCScope('openid email profile');
      await grant.save();
      return grant;
    },
  });
  provider.Client.prototype.redirectUriAllowed = (value: string) =>
    value.startsWith(redirectPrefix);
  const callback = provider.callback();
  const server: Server = createServer((request, response) => {
    void callback(request, response);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    issuer,
    clientId,
    clientSecret,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
