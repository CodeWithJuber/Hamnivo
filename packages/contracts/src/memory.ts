import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';

/**
 * Governed customer memory (L01–L05, L07, G19): what is remembered about a customer, where it
 * came from, how it changed, and the customer's and staff's controls over it.
 */

/** Version of the memory explanation a customer agrees to; stored with each consent decision. */
export const MEMORY_NOTICE_VERSION = 'memory-notice/1';

export const MemoryKind = z
  .enum([
    'observation',
    'episode',
    'claim',
    'preference',
    'procedure',
    'commitment',
    'constraint',
    'outcome',
    'correction',
  ])
  .meta({ id: 'MemoryKind' });

/** `active` may be used; `pending` waits for review; the others are history. */
export const MemoryStatus = z
  .enum(['active', 'pending', 'superseded', 'outdated'])
  .meta({ id: 'MemoryStatus' });

export const MemorySourceType = z.enum([
  'customer_statement',
  'customer_control',
  'staff_entry',
  'agent_inference',
  'system_record',
  'import',
]);

export const MemoryWriteReason = z.enum([
  'extracted_from_message',
  'customer_correction',
  'customer_confirmation',
  'staff_correction',
  'staff_confirmation',
]);

export const MemoryItem = z
  .object({
    id: typeId('memory'),
    customerId: typeId('customer'),
    brandId: typeId('brand'),
    /** The memory slot, such as `preferred_language`. */
    key: z.string(),
    kind: MemoryKind,
    value: z.string(),
    status: MemoryStatus,
    reviewStatus: z.enum(['auto', 'confirmed', 'pending']),
    /** `person`: this customer in every chat. `conversation`: only the chat it came from. */
    scope: z.enum(['person', 'conversation']),
    purpose: z.string(),
    sensitivity: z.enum(['normal', 'personal']),
    /** Claims stay `unknown` until a system of record confirms them. */
    evidenceStatus: z.enum(['supported', 'refuted', 'conflicting', 'unknown']),
    source: z.object({
      type: MemorySourceType,
      /** The messages it came from (msg_…). */
      messageIds: z.array(z.string()),
      conversationId: typeId('conversation').nullable(),
      observedAt: Timestamp,
    }),
    writtenBy: z.object({
      type: z.enum(['customer', 'staff', 'ai', 'system']),
      /** Shown to staff only. */
      id: z.string().nullable(),
      name: z.string().nullable(),
    }),
    reason: MemoryWriteReason,
    /** Why staff changed it (staff only). */
    note: z.string().nullable(),
    version: z.int().positive(),
    supersedes: typeId('memory').nullable(),
    supersededBy: typeId('memory').nullable(),
    /** The current value this one disagrees with, while it waits for review (HNV-15-03). */
    conflictsWith: typeId('memory').nullable(),
    validFrom: Timestamp,
    validUntil: Timestamp.nullable(),
    expiresAt: Timestamp.nullable(),
    recordedAt: Timestamp,
    supersededAt: Timestamp.nullable(),
    lastConfirmedAt: Timestamp.nullable(),
    reviewedAt: Timestamp.nullable(),
    policyVersion: z.string(),
  })
  .meta({ id: 'MemoryItem' });
export type MemoryItem = z.infer<typeof MemoryItem>;

export const MemoryConsentState = z
  .enum(['undecided', 'granted', 'declined', 'withdrawn'])
  .meta({ id: 'MemoryConsentState' });
export type MemoryConsentState = z.infer<typeof MemoryConsentState>;

/** Consent to personal memory, separate from any consent to learning or training (L08). */
export const MemoryConsent = z
  .object({
    state: MemoryConsentState,
    decidedAt: Timestamp.nullable(),
    noticeVersion: z.string().nullable(),
  })
  .meta({ id: 'MemoryConsent' });
export type MemoryConsent = z.infer<typeof MemoryConsent>;

export const MemoryDeletionReceipt = z
  .object({
    id: typeId('memoryDeletion'),
    scope: z.enum(['record', 'customer']),
    reason: z.enum([
      'customer_request',
      'staff_request',
      'erasure_request',
      'retention_expired',
      'review_rejected',
    ]),
    /** `completed` only after indexes and caches are purged and verified. */
    status: z.enum(['pending', 'completed']),
    records: z.int().nonnegative(),
    steps: z.array(
      z.object({
        step: z.enum(['records', 'embeddings', 'citations', 'caches', 'verification']),
        status: z.enum(['done', 'pending']),
      }),
    ),
    /** What deliberately stays, and is explained to the customer (HNV-15-05). */
    kept: z.array(z.enum(['audit_log', 'consent_log', 'deletion_record', 'chat_history'])),
    requestedBy: z.object({
      type: z.enum(['customer', 'staff', 'system']),
      id: z.string().nullable(),
      name: z.string().nullable(),
    }),
    createdAt: Timestamp,
    completedAt: Timestamp.nullable(),
  })
  .meta({ id: 'MemoryDeletionReceipt' });
export type MemoryDeletionReceipt = z.infer<typeof MemoryDeletionReceipt>;

/** What a customer sees in "What we remember". */
export const CustomerMemory = z
  .object({
    /** The assistant here can remember preferences; nothing is kept without consent. */
    offered: z.boolean(),
    consent: MemoryConsent,
    /** Current values and values waiting for the customer's confirmation. */
    items: z.array(MemoryItem),
    /** The longest any memory is kept, in days. */
    maxRetentionDays: z.int().positive(),
  })
  .meta({ id: 'CustomerMemory' });
export type CustomerMemory = z.infer<typeof CustomerMemory>;

export const SetMemoryConsentRequest = z
  .object({
    state: z.enum(['granted', 'declined', 'withdrawn']),
    /** The explanation the customer saw (MEMORY_NOTICE_VERSION). */
    noticeVersion: z.string().trim().min(1).max(40),
  })
  .meta({ id: 'SetMemoryConsentRequest' });

export const CorrectMemoryRequest = z
  .object({ value: z.string().trim().min(1).max(200) })
  .meta({ id: 'CorrectMemoryRequest' });

/** The result of a correction or confirmation, with the policy's plain explanation. */
export const MemoryChange = z
  .object({
    outcome: z.enum(['corrected', 'confirmed', 'unchanged', 'outdated']),
    memory: MemoryItem,
    explanation: z.string(),
  })
  .meta({ id: 'MemoryChange' });
export type MemoryChange = z.infer<typeof MemoryChange>;

export const StaffCorrectMemoryRequest = z
  .object({
    value: z.string().trim().min(1).max(200),
    /** Why, kept with the new value (and deleted with it). */
    reason: z.string().trim().min(1).max(300),
    /** When the new value took effect, if earlier than now ("changed yesterday"). */
    validFrom: Timestamp.optional(),
  })
  .meta({ id: 'StaffCorrectMemoryRequest' });

export const MemoryReasonRequest = z
  .object({ reason: z.string().trim().min(1).max(300) })
  .meta({ id: 'MemoryReasonRequest' });

export const EraseCustomerMemoryRequest = z
  .object({
    reason: z.string().trim().min(1).max(300),
    /** Also turn memory off, so nothing new is remembered. */
    turnOff: z.boolean().default(true),
  })
  .meta({ id: 'EraseCustomerMemoryRequest' });

export const MemoryCustomerRef = z
  .object({
    id: typeId('customer'),
    brandId: typeId('brand'),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    verified: z.boolean(),
    since: Timestamp,
  })
  .meta({ id: 'MemoryCustomerRef' });

export const MemoryCustomerSummary = z
  .object({
    customer: MemoryCustomerRef,
    consent: MemoryConsentState,
    active: z.int().nonnegative(),
    pending: z.int().nonnegative(),
    lastChangedAt: Timestamp.nullable(),
  })
  .meta({ id: 'MemoryCustomerSummary' });
export type MemoryCustomerSummary = z.infer<typeof MemoryCustomerSummary>;

export const MemoryConsentRecord = MemoryConsent.extend({
  decidedBy: z.enum(['customer', 'staff']),
}).meta({ id: 'MemoryConsentRecord' });

export const MemoryCustomerDetail = z
  .object({
    customer: MemoryCustomerRef,
    /** The brand's assistant uses memory. */
    offered: z.boolean(),
    consent: MemoryConsent,
    consentHistory: z.array(MemoryConsentRecord),
    /** Current and pending values. */
    items: z.array(MemoryItem),
    /** Superseded and outdated values, newest first. */
    history: z.array(MemoryItem),
    deletions: z.array(MemoryDeletionReceipt),
  })
  .meta({ id: 'MemoryCustomerDetail' });
export type MemoryCustomerDetail = z.infer<typeof MemoryCustomerDetail>;

/** Everything remembered about one customer, for an access request. */
export const MemoryExport = z
  .object({
    exportedAt: Timestamp,
    policyVersion: z.string(),
    customer: MemoryCustomerRef,
    consentHistory: z.array(MemoryConsentRecord),
    records: z.array(MemoryItem),
    deletions: z.array(MemoryDeletionReceipt),
  })
  .meta({ id: 'MemoryExport' });
