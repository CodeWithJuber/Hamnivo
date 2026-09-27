import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';

/** A website origin (scheme, host and optional port; no path), e.g. `https://shop.example.com`. */
export const WebOrigin = z
  .string()
  .max(300)
  .regex(/^https?:\/\/[^/?#\s]+$/, 'Expected an origin such as https://shop.example.com')
  .transform((value) => new URL(value).origin);

export const BrandStatus = z.enum(['active', 'disabled']);

export const CreateBrandRequest = z
  .object({
    workspaceId: typeId('workspace'),
    name: z.string().trim().min(1).max(80),
    /** Websites allowed to embed this brand's chat widget. */
    allowedOrigins: z.array(WebOrigin).max(50).default([]),
  })
  .meta({ id: 'CreateBrandRequest' });

export const Brand = z
  .object({
    id: typeId('brand'),
    workspaceId: typeId('workspace'),
    name: z.string(),
    /** Public widget identifier for the loader snippet; not a credential. */
    widgetId: typeId('widget'),
    allowedOrigins: z.array(z.string()),
    status: BrandStatus,
    createdAt: Timestamp,
  })
  .meta({ id: 'Brand' });
export type Brand = z.infer<typeof Brand>;

export const ConnectChatwootRequest = z
  .object({
    /** Brand whose conversations the new Chatwoot inbox carries. */
    brandId: typeId('brand'),
  })
  .meta({ id: 'ConnectChatwootRequest' });

export const AuthorityConnection = z
  .object({
    id: typeId('connection'),
    kind: z.literal('chatwoot'),
    baseUrl: z.url(),
    accountId: z.int().positive(),
    status: z.enum(['provisioning', 'active', 'degraded', 'disabled']),
    inboxes: z.array(
      z.object({
        id: typeId('inbox'),
        brandId: typeId('brand').nullable(),
        purpose: z.enum(['live', 'import']),
        externalInboxId: z.int().positive(),
      }),
    ),
    createdAt: Timestamp,
  })
  .meta({ id: 'AuthorityConnection' });
export type AuthorityConnection = z.infer<typeof AuthorityConnection>;
