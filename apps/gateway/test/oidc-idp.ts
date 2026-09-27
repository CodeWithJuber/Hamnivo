import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair } from 'jose';
import Provider, { type Configuration } from 'oidc-provider';

/** Who signs in at the identity provider next, with the claims it asserts. */
export interface IdpIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface TestIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The identity the next login at the provider becomes. */
  signInAs(identity: IdpIdentity): void;
  close(): Promise<void>;
}

/**
 * A real OpenID Connect provider (oidc-provider) on a local port, for single sign-on tests. Login
 * needs no form: whoever the test named with `signInAs` is signed in, and consent is implied, so a
 * test only follows redirects. The client accepts any redirect URI under `redirectPrefix`, since
 * Hamnivo gives each connection its own callback path.
 */
export async function startTestIdp(options: {
  port: number;
  redirectPrefix: string;
}): Promise<TestIdp> {
  const issuer = `http://127.0.0.1:${options.port}`;
  const clientId = 'hamnivo-test';
  const clientSecret = randomBytes(24).toString('base64url');
  const accounts = new Map<string, IdpIdentity>();
  let next: IdpIdentity | null = null;

  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const signing = { ...(await exportJWK(privateKey)), kid: 'test-idp', alg: 'RS256', use: 'sig' };

  const configuration: Configuration = {
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [`${options.redirectPrefix}placeholder`],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    jwks: { keys: [signing] },
    cookies: { keys: [randomBytes(16).toString('hex')] },
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'] },
    features: { devInteractions: { enabled: false } },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    pkce: { required: () => true },
    async findAccount(_ctx, sub) {
      const identity = accounts.get(sub);
      if (!identity) return undefined;
      return {
        accountId: sub,
        claims: async () => ({
          sub,
          email: identity.email,
          email_verified: identity.emailVerified,
          name: identity.name,
        }),
      };
    },
    // First-party test client: consent is implied for the scopes it asks for.
    async loadExistingGrant(ctx) {
      const accountId = ctx.oidc.session?.accountId;
      const client = ctx.oidc.client;
      if (!accountId || !client) return undefined;
      const grant = new ctx.oidc.provider.Grant({ clientId: client.clientId, accountId });
      grant.addOIDCScope('openid email profile');
      await grant.save();
      return grant;
    },
  };
  const provider = new Provider(issuer, configuration);
  const allowed = (value: string) => value.startsWith(options.redirectPrefix);
  provider.Client.prototype.redirectUriAllowed = allowed;
  provider.on('server_error', (_ctx, error) => {
    process.stderr.write(`test identity provider error: ${String(error)}\n`);
  });

  const callback = provider.callback();
  const server: Server = createServer((request, response) => {
    if (request.url?.startsWith('/interaction/')) {
      const identity = next;
      if (!identity) {
        response.writeHead(400).end('no identity chosen for this login');
        return;
      }
      accounts.set(identity.sub, identity);
      void provider
        .interactionFinished(
          request,
          response,
          { login: { accountId: identity.sub } },
          { mergeWithLastSubmission: false },
        )
        .catch((error: unknown) => {
          response.writeHead(500).end(String(error));
        });
      return;
    }
    void callback(request, response);
  });
  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));

  return {
    issuer,
    clientId,
    clientSecret,
    signInAs(identity) {
      next = identity;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A browser at the identity provider: follows its redirects with its own cookies. */
export class IdpBrowser {
  private readonly cookies = new Map<string, string>();

  /**
   * Opens the authorization URL and follows the provider's redirects until it sends the browser
   * back to the application; returns that final URL (the application's callback).
   */
  async authorize(url: string, issuer: string): Promise<URL> {
    let current = new URL(url);
    for (let hop = 0; hop < 10; hop++) {
      if (current.origin !== issuer) return current;
      const response = await fetch(current, {
        redirect: 'manual',
        headers: this.cookies.size
          ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
          : {},
      });
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const [name, ...rest] = (pair ?? '').split('=');
        if (!name) continue;
        const value = rest.join('=');
        if (!value || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name.trim());
        else this.cookies.set(name.trim(), value);
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`identity provider answered ${response.status}: ${await response.text()}`);
      }
      current = new URL(location, current);
    }
    throw new Error('too many redirects at the identity provider');
  }
}
