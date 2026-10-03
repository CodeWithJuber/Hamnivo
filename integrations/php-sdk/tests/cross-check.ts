/**
 * The other direction of the cross tests: what the PHP SDK signs, checked by @hamnivo/server's side.
 *
 *   pnpm exec tsx integrations/php-sdk/tests/cross-check.ts
 *
 * It runs tests/cross/emit.php (PHP, the real clock, fresh random values, no Composer) and then
 * checks every assertion with jose and the gateway's own options and claims contract, and every
 * webhook with `verifyWebhook` from @hamnivo/server. Needs `php` on the PATH.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const say = (line: string) => process.stdout.write(`${line}\n`);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
  say('php is not installed here, so the PHP to Node cross check was skipped.');
  process.exit(0);
}

const { IdentityAssertionClaims } = await import(join(root, 'packages/contracts/src/widget.ts'));
const { verifyWebhook } = await import(join(root, 'packages/server-sdk/src/index.ts'));
// jose is a dependency of @hamnivo/server; load the copy that package uses.
const sdk = createRequire(join(root, 'packages/server-sdk/package.json'));
const jose = await import(sdk.resolve('jose'));

interface Key {
  kid: string;
  secret?: string;
  publicJwk?: Record<string, string>;
}
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures/identity.json'), 'utf8')) as {
  keys: Record<string, Key>;
};
const emitted = JSON.parse(
  execFileSync('php', [join(here, 'cross/emit.php')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
) as {
  widgetId: string;
  assertions: { alg: string; customer: Record<string, unknown>; assertion: string }[];
  webhooks: { secret: string; id: string; timestamp: number; body: string; signature: string }[];
};

const problems: string[] = [];
const jtis = new Set<string>();

for (const { alg, customer, assertion } of emitted.assertions) {
  const key = fixtures.keys[alg] as Key;
  const verificationKey =
    alg === 'HS256'
      ? new TextEncoder().encode(key.secret)
      : await jose.importJWK(key.publicJwk, alg);
  try {
    // The same steps and options as WidgetSessionsService.identify in the gateway.
    const verified = await jose.jwtVerify(assertion, verificationKey, {
      algorithms: [alg],
      audience: emitted.widgetId,
      maxTokenAge: '5m',
      requiredClaims: ['sub', 'exp', 'iat', 'jti'],
    });
    const claims = IdentityAssertionClaims.parse(verified.payload) as {
      sub: string;
      exp: number;
      iat: number;
      jti: string;
      name?: string;
      email?: string;
      email_verified?: boolean;
    };
    const header = verified.protectedHeader as Record<string, unknown>;
    if (JSON.stringify(Object.keys(header)) !== '["alg","kid","typ"]' || header.typ !== 'JWT') {
      problems.push(`${alg}: unexpected header ${JSON.stringify(header)}`);
    }
    if (claims.exp - claims.iat !== 120) problems.push(`${alg}: lifetime is not 120 seconds`);
    if (claims.sub !== customer.id) problems.push(`${alg}: sub is ${claims.sub}`);
    if (claims.name !== customer.name) problems.push(`${alg}: name changed`);
    if (claims.email !== customer.email) problems.push(`${alg}: email changed`);
    if (claims.email_verified !== customer.emailVerified)
      problems.push(`${alg}: email_verified changed`);
    if (jtis.has(claims.jti)) problems.push(`${alg}: a jti was used twice`);
    jtis.add(claims.jti);
  } catch (error) {
    problems.push(`${alg}: ${(error as Error).message}`);
  }
}

for (const hook of emitted.webhooks) {
  try {
    const event = await verifyWebhook(
      hook.body,
      {
        'webhook-id': hook.id,
        'webhook-timestamp': String(hook.timestamp),
        'webhook-signature': hook.signature,
      },
      { secret: hook.secret },
    );
    if (JSON.stringify(event) !== JSON.stringify(JSON.parse(hook.body)))
      problems.push('a webhook event changed');
  } catch (error) {
    problems.push(`webhook ${hook.id}: ${(error as Error).message}`);
  }
}

if (problems.length > 0) {
  console.error(
    `The Node SDK side refused what PHP signed:\n- ${[...new Set(problems)].slice(0, 20).join('\n- ')}`,
  );
  process.exit(1);
}
say(
  `PHP to Node cross check passed: ${emitted.assertions.length} assertions (HS256, ES256, EdDSA, RS256) verified by jose with the gateway's options, ${emitted.webhooks.length} webhooks verified by @hamnivo/server.`,
);
