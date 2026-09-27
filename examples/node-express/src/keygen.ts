import { generateIdentityKey, identityKeyRequest, type PublicKeyAlg } from '@hamnivo/server';

// Makes a key pair for this example. It prints the body that registers the public key with
// Hamnivo, and the lines for .env. The private key is printed only here, for your .env file.
const alg = (process.argv[2] ?? 'ES256') as PublicKeyAlg;
const key = await generateIdentityKey(alg);

process.stdout.write(`1. Register the public key for the brand (POST /v1/admin/brands/{brandId}/identity-keys):

${JSON.stringify(identityKeyRequest(key.publicJwk, key.kid))}

2. Add these lines to .env. Keep the private key on this server only:

HAMNIVO_IDENTITY_KID=${key.kid}
HAMNIVO_IDENTITY_KEY='${JSON.stringify(key.privateJwk)}'
`);
