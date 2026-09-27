import type { IdentityKeyAlg, IdentitySigningKey } from '@hamnivo/server';

export interface Config {
  port: number;
  widgetId: string;
  widgetOrigin: string;
  api: string;
  key: IdentitySigningKey;
}

const ALGORITHM_BY_KEY_TYPE: Record<string, IdentityKeyAlg> = {
  EC: 'ES256',
  OKP: 'EdDSA',
  RSA: 'RS256',
};

/** Reads the settings (see .env.example). Error messages never include key material. */
export function readConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Set ${name} (see .env.example).`);
    return value;
  };
  const widgetId = required('HAMNIVO_WIDGET_ID');
  const kid = required('HAMNIVO_IDENTITY_KID');
  const { HAMNIVO_IDENTITY_KEY: privateJwk, HAMNIVO_IDENTITY_SECRET: secret } = env;
  if (privateJwk && secret) {
    throw new Error('Set HAMNIVO_IDENTITY_KEY or HAMNIVO_IDENTITY_SECRET, not both.');
  }
  let key: IdentitySigningKey;
  if (secret) {
    key = { kid, alg: 'HS256', secret };
  } else if (privateJwk) {
    const jwk = parseJwk(privateJwk);
    const alg = ALGORITHM_BY_KEY_TYPE[String(jwk.kty)];
    if (!alg) throw new Error('HAMNIVO_IDENTITY_KEY must be an EC, OKP (Ed25519) or RSA key.');
    key = { kid, alg, privateKey: jwk };
  } else {
    throw new Error('Set HAMNIVO_IDENTITY_KEY (a private JWK) or HAMNIVO_IDENTITY_SECRET (HS256).');
  }
  const origin = (value: string | undefined, fallback: string) =>
    (value?.trim() || fallback).replace(/\/+$/, '');
  return {
    port: Number(env.PORT?.trim() || 8080),
    widgetId,
    widgetOrigin: origin(env.HAMNIVO_WIDGET_ORIGIN, 'http://localhost:5174'),
    api: origin(env.HAMNIVO_API, 'http://localhost:4000'),
    key,
  };
}

function parseJwk(json: string): Record<string, unknown> {
  let jwk: unknown;
  try {
    jwk = JSON.parse(json);
  } catch {
    // JSON.parse quotes part of its input in its error, and this input is a private key.
    throw new Error('HAMNIVO_IDENTITY_KEY is not valid JSON. Put the private JWK on one line.');
  }
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) {
    throw new Error('HAMNIVO_IDENTITY_KEY must be a JWK object.');
  }
  return jwk as Record<string, unknown>;
}
