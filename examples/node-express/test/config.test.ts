import { generateIdentityKey } from '@hamnivo/server';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

const required = {
  HAMNIVO_WIDGET_ID: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
  HAMNIVO_IDENTITY_KID: 'k1',
};

describe('readConfig', () => {
  it('reads an HS256 secret, with local defaults for the rest', () => {
    const config = readConfig({ ...required, HAMNIVO_IDENTITY_SECRET: 'the-secret' });
    expect(config).toEqual({
      port: 8080,
      widgetId: required.HAMNIVO_WIDGET_ID,
      widgetOrigin: 'http://localhost:5174',
      api: 'http://localhost:4000',
      key: { kid: 'k1', alg: 'HS256', secret: 'the-secret' },
    });
  });

  it.each(['ES256', 'EdDSA', 'RS256'] as const)('reads an %s private JWK', async (alg) => {
    const key = await generateIdentityKey(alg);
    const config = readConfig({
      ...required,
      HAMNIVO_IDENTITY_KEY: JSON.stringify(key.privateJwk),
    });
    expect(config.key).toEqual({ kid: 'k1', alg, privateKey: key.privateJwk });
  });

  it('uses the addresses and port it is given, and treats empty values as unset', () => {
    const config = readConfig({
      ...required,
      HAMNIVO_IDENTITY_KEY: '',
      HAMNIVO_IDENTITY_SECRET: 'the-secret',
      HAMNIVO_WIDGET_ORIGIN: 'https://chat.example.com/',
      HAMNIVO_API: 'https://api.example.com',
      PORT: '3000',
    });
    expect(config).toMatchObject({
      port: 3000,
      widgetOrigin: 'https://chat.example.com',
      api: 'https://api.example.com',
      key: { alg: 'HS256' },
    });
  });

  it.each([
    [
      'a missing widget ID',
      { HAMNIVO_IDENTITY_KID: 'k1', HAMNIVO_IDENTITY_SECRET: 's' },
      /Set HAMNIVO_WIDGET_ID/,
    ],
    [
      'a missing key id',
      { HAMNIVO_WIDGET_ID: 'wid_x', HAMNIVO_IDENTITY_SECRET: 's' },
      /Set HAMNIVO_IDENTITY_KID/,
    ],
    ['a missing key', required, /Set HAMNIVO_IDENTITY_KEY .* or HAMNIVO_IDENTITY_SECRET/],
    [
      'a key and a secret together',
      { ...required, HAMNIVO_IDENTITY_KEY: '{"kty":"EC"}', HAMNIVO_IDENTITY_SECRET: 's' },
      /not both/,
    ],
    [
      'a key that is not a JWK object',
      { ...required, HAMNIVO_IDENTITY_KEY: '["EC"]' },
      /must be a JWK object/,
    ],
    [
      'a key of another type',
      { ...required, HAMNIVO_IDENTITY_KEY: '{"kty":"oct","k":"abc"}' },
      /EC, OKP \(Ed25519\) or RSA/,
    ],
  ])('explains %s', (_name, env, message) => {
    expect(() => readConfig(env)).toThrow(message);
  });

  it('never repeats the private key when it cannot be read', () => {
    const broken = '{"kty":"EC","crv":"P-256","d":SECRETVALUE123}';
    // JSON.parse itself would quote the key in its message.
    expect(() => JSON.parse(broken)).toThrow(/SECRETVALU/);
    expect(() => readConfig({ ...required, HAMNIVO_IDENTITY_KEY: broken })).toThrow(
      /^HAMNIVO_IDENTITY_KEY is not valid JSON\. Put the private JWK on one line\.$/,
    );
  });
});
