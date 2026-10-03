/**
 * Writes the test vectors the PHP SDK is held to: what `@hamnivo/server` produces for the same
 * input, with the clock and the random `jti` held still.
 *
 *   pnpm exec tsx integrations/php-sdk/tests/fixtures/generate.ts          # rewrite the fixtures
 *   pnpm exec tsx integrations/php-sdk/tests/fixtures/generate.ts --check  # fail when they drifted
 *
 * - identity.json: assertions for every algorithm, and the inputs the Node SDK refuses.
 *   HS256, EdDSA and RS256 signatures are deterministic, so PHP must produce the same text, byte for
 *   byte. ES256 signatures are random, so PHP must produce the same header and payload and a
 *   signature that verifies with the public key.
 * - webhooks.json: signatures and verification outcomes of the Standard Webhooks flow.
 *
 * The keys in the fixtures are throwaway test keys. They sign nothing real and are kept so that
 * running this again changes only what the Node SDK changed.
 */
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify, webcrypto } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIdentityAssertion,
  generateIdentityKey,
  HamnivoIdentityError,
  HamnivoWebhookError,
  type IdentityAssertionOptions,
  signWebhook,
  verifyWebhook,
} from '../../../../packages/server-sdk/src/index.js';

const say = (line: string) => process.stdout.write(`${line}\n`);
const here = dirname(fileURLToPath(import.meta.url));
const identityPath = join(here, 'identity.json');
const webhooksPath = join(here, 'webhooks.json');
const check = process.argv.includes('--check');

const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
/** The clock of every identity case: 2026-09-15T08:00:00Z. */
const NOW = 1_789_459_200;

type Alg = 'HS256' | 'ES256' | 'EdDSA' | 'RS256';
type JWK = Record<string, unknown>;
const base64url = {
  encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
};

interface KeyFixture {
  kid: string;
  secret?: string;
  privateJwk?: JWK;
  publicJwk?: JWK;
}

// ---------------------------------------------------------------- keys

const previous = existsSync(identityPath)
  ? (JSON.parse(readFileSync(identityPath, 'utf8')) as {
      keys?: Record<Alg, KeyFixture>;
      weakRsaJwk?: JWK;
    })
  : {};

async function keyFor(alg: Alg): Promise<KeyFixture> {
  const kept = previous.keys?.[alg];
  if (kept) return kept;
  if (alg === 'HS256') {
    return {
      kid: 'hk_fixture',
      secret: base64url.encode(webcrypto.getRandomValues(new Uint8Array(32))),
    };
  }
  const key = await generateIdentityKey(alg);
  return {
    kid: `fixture-${alg.toLowerCase()}`,
    privateJwk: key.privateJwk as JWK,
    publicJwk: key.publicJwk as JWK,
  };
}

const keys: Record<Alg, KeyFixture> = {
  HS256: await keyFor('HS256'),
  ES256: await keyFor('ES256'),
  EdDSA: await keyFor('EdDSA'),
  RS256: await keyFor('RS256'),
};

function keyOption(alg: Alg): IdentityAssertionOptions['key'] {
  const key = keys[alg];
  return alg === 'HS256'
    ? { kid: key.kid, alg, secret: key.secret as string }
    : { kid: key.kid, alg, privateKey: key.privateJwk as JWK };
}

// ---------------------------------------------------------------- a still clock and a known jti

/** The jti of a case: 16 bytes from its name, so every case differs and none changes by chance. */
function jtiBytes(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(name).digest().subarray(0, 16));
}

async function signAt<T>(name: string, run: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => NOW * 1000;
  Object.defineProperty(webcrypto, 'getRandomValues', {
    configurable: true,
    writable: true,
    value: (target: Uint8Array) => {
      target.set(jtiBytes(name));
      return target;
    },
  });
  try {
    return await run();
  } finally {
    Date.now = realNow;
    // Back to the method every Crypto object inherits.
    Reflect.deleteProperty(webcrypto, 'getRandomValues');
  }
}

// ---------------------------------------------------------------- identity cases

interface IdentityCase {
  name: string;
  alg: Alg;
  now: number;
  jti: string;
  options: IdentityAssertionOptions;
  expected: string;
  /** False for ES256: the signature differs on every signing. */
  deterministic: boolean;
}

const full = {
  id: 'customer-42',
  name: 'Ayesha Khan',
  email: 'ayesha@example.com',
  emailVerified: true,
};

const customers: [string, IdentityAssertionOptions['customer']][] = [
  ['a full customer', full],
  ['only an id', { id: 'customer-7' }],
  [
    'optional fields set to null',
    { id: 'customer-8', name: null, email: null, emailVerified: null },
  ],
  ['an unverified email', { id: 'customer-9', email: 'omar@example.com', emailVerified: false }],
  [
    'an Urdu name',
    { id: 'u-1', name: 'عائشة خان', email: 'ayesha@example.pk', emailVerified: true },
  ],
  [
    'a Hindi name',
    { id: 'h-1', name: 'आयशा खान', email: 'ayesha@example.in', emailVerified: true },
  ],
  ['an emoji name', { id: 'e-1', name: 'Sam 🙂 Lee' }],
  [
    'text that JSON must escape',
    { id: 'j-1', name: 'say "hi" \\ a/b \u0001 \n \t \u2028 \u2029 \u007f é' },
  ],
  ['a numeric-looking id', { id: '0', name: 'Zero' }],
  ['an id of 200 characters', { id: 'x'.repeat(200) }],
  ['an id of 100 emoji, which is 200 UTF-16 units', { id: '🙂'.repeat(100) }],
  ['a name of 120 characters', { id: 'n-1', name: 'n'.repeat(120) }],
  ['a name of 60 emoji, which is 120 UTF-16 units', { id: 'n-2', name: '🙂'.repeat(60) }],
  ['a name with a leading and a trailing space', { id: 'n-3', name: '  Padded Name  ' }],
];

const lifetimes: [string, number | undefined][] = [
  ['the default lifetime', undefined],
  ['the shortest lifetime', 10],
  ['a lifetime of 60 seconds', 60],
  ['the longest lifetime', 300],
  ['a lifetime over the maximum, which is capped', 86_400],
];

async function identityCases(): Promise<IdentityCase[]> {
  const cases: IdentityCase[] = [];
  const add = async (
    name: string,
    alg: Alg,
    customer: IdentityAssertionOptions['customer'],
    ttlSeconds?: number,
    kid?: string,
  ) => {
    const options: IdentityAssertionOptions = {
      widgetId: WIDGET,
      key: kid ? { ...keyOption(alg), kid } : keyOption(alg),
      customer,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    };
    const label = `${alg}: ${name}`;
    cases.push({
      name: label,
      alg,
      now: NOW,
      jti: base64url.encode(jtiBytes(label)),
      options: JSON.parse(JSON.stringify(options)) as IdentityAssertionOptions,
      expected: await signAt(label, () => createIdentityAssertion(options)),
      deterministic: alg !== 'ES256',
    });
  };
  for (const alg of ['HS256', 'ES256', 'EdDSA', 'RS256'] as const) {
    for (const [name, customer] of customers) {
      if (
        alg !== 'HS256' &&
        ![
          'a full customer',
          'only an id',
          'an Urdu name',
          'an emoji name',
          'text that JSON must escape',
        ].includes(name)
      )
        continue;
      await add(name, alg, customer);
    }
  }
  for (const [name, ttl] of lifetimes) await add(name, 'HS256', full, ttl);
  await add(
    'a key id of 64 characters with dots, dashes and underscores',
    'HS256',
    full,
    undefined,
    `a.${'b-c_'.repeat(15)}z`.slice(0, 64),
  );
  return cases;
}

// ---------------------------------------------------------------- identity errors

interface ErrorCase {
  name: string;
  options: unknown;
  /** What `@hamnivo/server` says. */
  message: string;
  /** True when the PHP SDK says exactly the same (the Node text has nothing JavaScript-only in it). */
  sameMessage: boolean;
}

async function weakRsaJwk(): Promise<JWK> {
  const pair = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return (await webcrypto.subtle.exportKey('jwk', pair.privateKey)) as JWK;
}

/** An RSA key of 1024 bits, which Hamnivo refuses. It is kept so that the fixtures stay the same. */
const weakRsa = previous.weakRsaJwk ?? (await weakRsaJwk());

async function errorCases(): Promise<ErrorCase[]> {
  const base = { widgetId: WIDGET, key: keyOption('HS256'), customer: full };
  const hs = (key: Record<string, unknown>) => ({
    ...base,
    key: { kid: 'k1', alg: 'HS256', ...key },
  });
  const asym = (alg: Alg, key: Record<string, unknown>) => ({
    ...base,
    key: { kid: 'k1', alg, ...key },
  });
  const customer = (changes: Record<string, unknown>) => ({
    ...base,
    customer: { ...full, ...changes },
  });
  const secret = keys.HS256.secret as string;
  const { d: _d, ...publicEc } = keys.ES256.privateJwk as JWK;
  const weak = weakRsa;

  // [name, options, the PHP SDK says the same words]
  const list: [string, unknown, boolean][] = [
    ['no widget ID', { ...base, widgetId: undefined }, true],
    [
      'a brand ID instead of the widget ID',
      { ...base, widgetId: 'brd_01j9zk7w3xq8r4t2v6m5n1p0ce' },
      true,
    ],
    ['a widget ID that is not text', { ...base, widgetId: 42 }, true],
    ['no key', { ...base, key: undefined }, false],
    ['a kid with a space', hs({ kid: 'shop key', secret }), true],
    ['a kid of 65 characters', hs({ kid: 'k'.repeat(65), secret }), true],
    ['an empty kid', hs({ kid: '', secret }), true],
    ['an algorithm Hamnivo does not accept', hs({ alg: 'HS512', secret }), true],
    ['the none algorithm', hs({ alg: 'none', secret }), true],
    ['HS256 without a secret', hs({}), true],
    ['HS256 with an empty secret', hs({ secret: '' }), true],
    ['a secret with a line break', hs({ secret: `${secret}\n` }), true],
    ['a secret with a space inside', hs({ secret: 'abc def' }), true],
    ['a secret with a no-break space', hs({ secret: `abc\u00a0def` }), true],
    ['HS256 with a private key', hs({ secret, privateKey: keys.ES256.privateJwk }), true],
    ['ES256 without a private key', asym('ES256', {}), true],
    ['ES256 with a secret', asym('ES256', { secret }), true],
    ['an Ed25519 key for ES256', asym('ES256', { privateKey: keys.EdDSA.privateJwk }), true],
    ['an RSA key for EdDSA', asym('EdDSA', { privateKey: keys.RS256.privateJwk }), true],
    ['an EC key for RS256', asym('RS256', { privateKey: keys.ES256.privateJwk }), true],
    ['a public key for ES256', asym('ES256', { privateKey: publicEc }), true],
    [
      'a key marked for another algorithm',
      asym('ES256', { privateKey: { ...keys.ES256.privateJwk, alg: 'RS256' } }),
      true,
    ],
    ['an RSA key under 2048 bits', asym('RS256', { privateKey: weak }), true],
    ['no customer', { ...base, customer: undefined }, false],
    ['an empty customer id', customer({ id: '' }), true],
    ['a blank customer id', customer({ id: '   ' }), true],
    ['a customer id of only no-break spaces', customer({ id: '\u00a0\u3000\ufeff' }), true],
    ['a customer id of 201 characters', customer({ id: 'x'.repeat(201) }), true],
    [
      'a customer id of 101 emoji, which is 202 UTF-16 units',
      customer({ id: '🙂'.repeat(101) }),
      true,
    ],
    ['a name of 121 characters', customer({ name: 'x'.repeat(121) }), true],
    ['a name of 61 emoji, which is 122 UTF-16 units', customer({ name: '🙂'.repeat(61) }), true],
    ['a name that is not text', customer({ name: 7 }), true],
    ['an email without a domain', customer({ email: 'nobody' }), true],
    ['an email with no dot in the domain', customer({ email: 'a@b' }), true],
    ['an email with a space', customer({ email: 'a b@example.com' }), true],
    ['an email with a trailing space', customer({ email: 'a@example.com ' }), true],
    ['an email with a trailing line break', customer({ email: 'a@example.com\n' }), true],
    ['an email with a non-ASCII letter', customer({ email: 'josé@example.com' }), true],
    ['an email that is not text', customer({ email: 5 }), true],
    ['an emailVerified that is not true or false', customer({ emailVerified: 'yes' }), true],
    ['a lifetime of 9 seconds', { ...base, ttlSeconds: 9 }, true],
    ['a lifetime of zero', { ...base, ttlSeconds: 0 }, true],
    ['a negative lifetime', { ...base, ttlSeconds: -60 }, true],
    ['a lifetime that is not whole', { ...base, ttlSeconds: 90.5 }, true],
    ['a lifetime in text', { ...base, ttlSeconds: '60' }, true],
  ];

  const out: ErrorCase[] = [];
  for (const [name, options, sameMessage] of list) {
    const sent = JSON.parse(JSON.stringify(options)) as unknown;
    let message = '';
    try {
      await createIdentityAssertion(options as IdentityAssertionOptions);
    } catch (error) {
      if (!(error instanceof HamnivoIdentityError)) throw error;
      message = error.message;
    }
    if (message === '') throw new Error(`The Node SDK accepted "${name}"`);
    out.push({ name, options: sent, message, sameMessage });
  }
  return out;
}

// ---------------------------------------------------------------- webhook cases

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const OTHER = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD';
const WEBHOOK_NOW = 1_789_459_200;
const EVENT_ID = 'evt_01k6a3p0a1b2c3d4e5f6g7h8j9';
const eventBody = JSON.stringify({
  id: EVENT_ID,
  type: 'conversation.created',
  timestamp: '2026-09-15T07:59:58.000Z',
  schemaVersion: '1.0',
  tenantId: 'tnt_01k6a3p0a1b2c3d4e5f6g7h8j9',
  data: { conversationId: 'conv_01k6a3p0a1b2c3d4e5f6g7h8j9', note: 'عائشة 🙂 "quoted"' },
});

const bodies: [string, string][] = [
  ['an event', eventBody],
  ['an empty object', '{}'],
  ['text with a line break and spaces', `{\n  "id": "evt_1",\n  "type": "x"\n}\n`],
  ['Urdu and emoji', '{"id":"evt_2","type":"message.created","data":{"text":"السلام عليكم 🙂"}}'],
  ['a long body', JSON.stringify({ id: 'evt_3', data: { text: 'x'.repeat(4_000) } })],
];

interface WebhookScenario {
  name: string;
  body: string;
  headers: Record<string, string>;
  options: { secret: string | string[]; toleranceSeconds?: number; now: number };
  expect: { event: unknown } | { error: string };
}

async function webhookScenarios(): Promise<WebhookScenario[]> {
  const sign = (secret: string, id: string, timestamp: number, body: string) =>
    signWebhook(secret, id, timestamp, body);
  const headers = (signature: string, timestamp = WEBHOOK_NOW, id = EVENT_ID) => ({
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signature,
  });
  const goodSignature = await sign(SECRET, EVENT_ID, WEBHOOK_NOW, eventBody);
  const otherSignature = await sign(OTHER, EVENT_ID, WEBHOOK_NOW, eventBody);
  const old = WEBHOOK_NOW - 301;
  const future = WEBHOOK_NOW + 301;
  const base = { secret: SECRET, now: WEBHOOK_NOW };

  const scenarios: [string, string, Record<string, string>, WebhookScenario['options']][] = [
    ['a valid request', eventBody, headers(goodSignature), base],
    [
      'the secret without its whsec_ prefix',
      eventBody,
      headers(goodSignature),
      { ...base, secret: SECRET.slice(6) },
    ],
    [
      'two signatures during a rotation, the first for another secret',
      eventBody,
      headers(`${otherSignature} ${goodSignature}`),
      base,
    ],
    [
      'a signature of a version this SDK does not know, then a good one',
      eventBody,
      headers(`v2,${'A'.repeat(43)}= ${goodSignature}`),
      base,
    ],
    [
      'the previous secret, with both secrets given',
      eventBody,
      headers(otherSignature),
      { ...base, secret: [SECRET, OTHER] },
    ],
    ['a signature for another secret', eventBody, headers(otherSignature), base],
    ['a body that was changed', `${eventBody} `, headers(goodSignature), base],
    ['another event id', eventBody, headers(goodSignature, WEBHOOK_NOW, 'evt_other'), base],
    ['a timestamp that was changed', eventBody, headers(goodSignature, WEBHOOK_NOW + 1), base],
    ['no signature value', eventBody, headers('v1,'), base],
    ['a signature cut short', eventBody, headers(goodSignature.slice(0, 12)), base],
    ['a signature that is not base64', eventBody, headers('v1,!!!!'), base],
    [
      'a timestamp 301 seconds old',
      eventBody,
      headers(await sign(SECRET, EVENT_ID, old, eventBody), old),
      base,
    ],
    [
      'a timestamp 301 seconds ahead',
      eventBody,
      headers(await sign(SECRET, EVENT_ID, future, eventBody), future),
      base,
    ],
    [
      'a timestamp exactly 300 seconds old',
      eventBody,
      headers(await sign(SECRET, EVENT_ID, WEBHOOK_NOW - 300, eventBody), WEBHOOK_NOW - 300),
      base,
    ],
    [
      'an old timestamp with a longer tolerance',
      eventBody,
      headers(await sign(SECRET, EVENT_ID, old, eventBody), old),
      { ...base, toleranceSeconds: 600 },
    ],
    ['a timestamp that is not a number', eventBody, headers('v1,x', Number.NaN), base],
    [
      'a timestamp of 13 digits',
      eventBody,
      { ...headers('v1,x'), 'webhook-timestamp': '1789459200000' },
      base,
    ],
    [
      'no webhook-id',
      eventBody,
      { 'webhook-timestamp': String(WEBHOOK_NOW), 'webhook-signature': goodSignature },
      base,
    ],
    [
      'no webhook-timestamp',
      eventBody,
      { 'webhook-id': EVENT_ID, 'webhook-signature': goodSignature },
      base,
    ],
    [
      'no webhook-signature',
      eventBody,
      { 'webhook-id': EVENT_ID, 'webhook-timestamp': String(WEBHOOK_NOW) },
      base,
    ],
    ['an empty webhook-id', eventBody, { ...headers(goodSignature), 'webhook-id': '' }, base],
    [
      'header names in capitals',
      eventBody,
      {
        'Webhook-Id': EVENT_ID,
        'Webhook-Timestamp': String(WEBHOOK_NOW),
        'Webhook-Signature': goodSignature,
      },
      base,
    ],
  ];
  for (const [name, body] of bodies.slice(1)) {
    const signature = await sign(SECRET, EVENT_ID, WEBHOOK_NOW, body);
    scenarios.push([`a valid request with ${name}`, body, headers(signature), base]);
  }
  for (const text of ['not json', '[]', '[1,2]', '"text"', '123', 'null', '']) {
    const signature = await sign(SECRET, EVENT_ID, WEBHOOK_NOW, text);
    scenarios.push([
      `a signed body that is ${JSON.stringify(text)}`,
      text,
      headers(signature),
      base,
    ]);
  }

  const out: WebhookScenario[] = [];
  for (const [name, body, sent, options] of scenarios) {
    let expectation: WebhookScenario['expect'];
    try {
      const event = await verifyWebhook(body, sent, {
        secret: options.secret,
        ...(options.toleranceSeconds === undefined
          ? {}
          : { toleranceSeconds: options.toleranceSeconds }),
        now: () => new Date(options.now * 1000),
      });
      expectation = { event };
    } catch (error) {
      if (!(error instanceof HamnivoWebhookError)) throw error;
      expectation = { error: error.code };
    }
    out.push({ name, body, headers: sent, options, expect: expectation });
  }
  return out;
}

async function webhookSignatures() {
  const out = [];
  for (const [name, body] of bodies) {
    for (const secret of [SECRET, OTHER, SECRET.slice(6)]) {
      out.push({
        name: `${name}, secret ${secret.slice(0, 11)}…`,
        secret,
        id: EVENT_ID,
        timestamp: WEBHOOK_NOW,
        body,
        signature: await signWebhook(secret, EVENT_ID, WEBHOOK_NOW, body),
      });
    }
  }
  // The vectors published with the Standard Webhooks reference libraries.
  out.push(
    {
      name: 'Standard Webhooks vector 1',
      secret: SECRET,
      id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      timestamp: 1614265330,
      body: '{"test": 2432232314}',
      signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    },
    {
      name: 'Standard Webhooks vector 2',
      secret: OTHER,
      id: 'msg_27UH4WbU6Z5A5EzD8u03UvzRbpk',
      timestamp: 1649367553,
      body: '{"email":"test@example.com","username":"test_user"}',
      signature: 'v1,tZ1I4/hDygAJgO5TYxiSd6Sd0kDW6hPenDe+bTa3Kkw=',
    },
  );
  return out;
}

// ---------------------------------------------------------------- write or check

const identity = {
  generatedBy: 'integrations/php-sdk/tests/fixtures/generate.ts, with @hamnivo/server',
  note: 'Throwaway test keys. They sign nothing real.',
  widgetId: WIDGET,
  now: NOW,
  keys,
  weakRsaJwk: weakRsa,
  cases: await identityCases(),
  errors: await errorCases(),
};
const webhooks = {
  generatedBy: 'integrations/php-sdk/tests/fixtures/generate.ts, with @hamnivo/server',
  secret: SECRET,
  otherSecret: OTHER,
  now: WEBHOOK_NOW,
  signatures: await webhookSignatures(),
  scenarios: await webhookScenarios(),
};

// Characters that are invisible or look like spaces are written as escapes, so that a reader of the
// fixtures can see them. The JSON means the same.
const INVISIBLE = /[\u2028\u2029\u00a0\u3000\ufeff]/g;
const escaped = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
const text = (value: unknown) => `${JSON.stringify(value, null, 2).replace(INVISIBLE, escaped)}\n`;

if (check) {
  const problems: string[] = [];
  const committed = JSON.parse(readFileSync(identityPath, 'utf8')) as typeof identity;
  for (const fresh of identity.cases) {
    const old = committed.cases.find((c) => c.name === fresh.name);
    if (!old) problems.push(`missing case: ${fresh.name}`);
    else if (old.deterministic && old.expected !== fresh.expected)
      problems.push(`changed: ${fresh.name}`);
    else if (!old.deterministic) {
      // The signature is random; the header, the payload and the signature's validity are not.
      if (
        old.expected.split('.').slice(0, 2).join('.') !==
        fresh.expected.split('.').slice(0, 2).join('.')
      ) {
        problems.push(`changed: ${fresh.name}`);
      }
      const [header, payload, signature] = old.expected.split('.') as [string, string, string];
      const publicKey = createPublicKey({ key: keys.ES256.publicJwk as never, format: 'jwk' });
      const valid = verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      );
      if (!valid) problems.push(`the signature no longer verifies: ${old.name}`);
    }
  }
  if (committed.cases.length !== identity.cases.length)
    problems.push('the number of cases changed');
  if (JSON.stringify(committed.errors) !== JSON.stringify(identity.errors))
    problems.push('the error cases changed');
  const committedHooks = JSON.parse(readFileSync(webhooksPath, 'utf8')) as unknown;
  if (JSON.stringify(committedHooks) !== JSON.stringify(JSON.parse(text(webhooks))))
    problems.push('the webhook vectors changed');
  if (problems.length > 0) {
    console.error(
      `The PHP SDK fixtures are out of date with @hamnivo/server:\n- ${problems.join('\n- ')}`,
    );
    console.error('Run: pnpm exec tsx integrations/php-sdk/tests/fixtures/generate.ts');
    process.exit(1);
  }
  say(
    `PHP SDK fixtures match @hamnivo/server (${identity.cases.length} assertions, ${identity.errors.length} refusals, ${webhooks.scenarios.length} webhook scenarios).`,
  );
} else {
  writeFileSync(identityPath, text(identity));
  writeFileSync(webhooksPath, text(webhooks));
  // Written the way the repository formats JSON, so `biome check` has nothing to change.
  spawnSync('pnpm', ['exec', 'biome', 'format', '--write', identityPath, webhooksPath], {
    cwd: join(here, '..', '..', '..', '..'),
    stdio: 'ignore',
  });
  say(
    `Wrote ${identity.cases.length} assertions, ${identity.errors.length} refusals and ${webhooks.scenarios.length} webhook scenarios.`,
  );
}
