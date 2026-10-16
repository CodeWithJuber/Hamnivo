import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';

/** Why a customer's data is exported or erased, as the business records it (A10). */
export const PrivacyReason = z.enum(['access_request', 'erasure_request', 'other']);
export type PrivacyReason = z.infer<typeof PrivacyReason>;

const Reference = z.string().trim().min(1).max(80).optional();

export const PrivacyCustomersQuery = z.object({
  /**
   * Name, email, phone or handle, the customer's ID in the business's systems, or a customer or
   * conversation ID from Studio.
   */
  query: z.string().trim().min(2).max(200),
  brandId: typeId('brand').optional(),
});

export const PrivacyCustomer = z
  .object({
    id: typeId('customer'),
    brand: z.object({ id: typeId('brand'), name: z.string() }),
    kind: z.enum(['anonymous', 'verified', 'channel']),
    name: z.string().nullable(),
    email: z.string().nullable(),
    /** The customer's ID in the business's own systems, for verified customers. */
    externalId: z.string().nullable(),
    /** Email address, phone number or handle, for customers who wrote on a channel. */
    channel: z.object({ kind: z.string(), handle: z.string() }).nullable(),
    lastSeenAt: Timestamp.nullable(),
    /** Erased on request; only an anonymous stub is left because orders point at it. */
    erasedAt: Timestamp.nullable(),
  })
  .meta({ id: 'PrivacyCustomer' });
export type PrivacyCustomer = z.infer<typeof PrivacyCustomer>;

export const PrivacyCustomerList = z
  .object({ items: z.array(PrivacyCustomer) })
  .meta({ id: 'PrivacyCustomerList' });

/** What exporting or erasing this customer covers. */
export const PrivacyCustomerSummary = z
  .object({
    customer: PrivacyCustomer,
    conversations: z.int().nonnegative(),
    orders: z.int().nonnegative(),
    memories: z.int().nonnegative(),
    /** The customer's Chatwoot contact also has conversations of another brand, which stay. */
    sharedContact: z.boolean(),
    /** Exports and erasures asked for this customer, newest first. */
    requests: z.array(z.lazy(() => PrivacyRequest)),
  })
  .meta({ id: 'PrivacyCustomerSummary' });
export type PrivacyCustomerSummary = z.infer<typeof PrivacyCustomerSummary>;

export const ExportCustomerRequest = z
  .object({ reason: PrivacyReason.default('access_request'), reference: Reference })
  .meta({ id: 'ExportCustomerRequest' });

export const EraseCustomerRequest = z
  .object({
    /** The customer's ID typed again, so the wrong customer is not erased by a slip. */
    confirm: z.string().trim(),
    reason: PrivacyReason.default('erasure_request'),
    reference: Reference,
  })
  .meta({ id: 'EraseCustomerRequest' });

export const PrivacyRequest = z
  .object({
    id: typeId('privacyRequest'),
    kind: z.enum(['export', 'erase']),
    customerId: typeId('customer'),
    brand: z.object({ id: typeId('brand'), name: z.string() }),
    state: z.enum(['queued', 'running', 'completed', 'blocked', 'failed']),
    reason: PrivacyReason,
    reference: z.string().nullable(),
    requestedBy: z.object({ id: typeId('staff'), name: z.string() }).nullable(),
    /** What was exported or deleted, by kind: conversations, messages, files, orders… */
    counts: z.record(z.string(), z.int()),
    /**
     * Why it stopped or what it could not do: `authority_not_admin` (Chatwoot's Hamnivo user is
     * not an administrator), `too_large`, `customer_missing`.
     */
    problem: z.string().nullable(),
    /** An export's file while it can be downloaded (24 hours). */
    file: z.object({ byteSize: z.int().nonnegative(), expiresAt: Timestamp }).nullable(),
    createdAt: Timestamp,
    completedAt: Timestamp.nullable(),
  })
  .meta({ id: 'PrivacyRequest' });
export type PrivacyRequest = z.infer<typeof PrivacyRequest>;

export const PrivacyRequestList = z
  .object({ items: z.array(PrivacyRequest) })
  .meta({ id: 'PrivacyRequestList' });
