import { createRequire } from 'node:module';
import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';

const require = createRequire(import.meta.url);

/** Serves the contract-generated OpenAPI 3.1 document and, optionally, the Scalar reference UI. */
export async function registerApiDocs(fastify: FastifyInstance, ui: boolean): Promise<void> {
  const document = require('@hamnivo/contracts/openapi.json') as object;
  fastify.get('/v1/openapi.json', async () => document);
  if (!ui) return;
  await fastify.register(scalar, {
    routePrefix: '/docs',
    configuration: { url: '/v1/openapi.json', title: 'Hamnivo API' },
  });
}
