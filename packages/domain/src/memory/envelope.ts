/**
 * Customer memory (blueprint §22, L01–L02): the product-owned envelope. Canonical records live in
 * PostgreSQL; search and embedding indexes are projections that can be rebuilt from them.
 */

/** What kind of thing a record is. Claims stay claims until a system of record confirms them. */
export const MEMORY_KINDS = [
  'observation',
  'episode',
  'claim',
  'preference',
  'procedure',
  'commitment',
  'constraint',
  'outcome',
  'correction',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Who a record is about and where it may be used. Customer memory is `person` or `conversation`. */
export const MEMORY_SCOPES = ['session', 'conversation', 'person', 'team', 'tenant'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Where the evidence came from. Authority depends on it: the customer is authoritative about
 * their own preferences; an agent's inference is only a proposal. */
export const MEMORY_SOURCE_TYPES = [
  /** The customer said it in a message (the model only transcribed it). */
  'customer_statement',
  /** The customer set or corrected it through the memory controls. */
  'customer_control',
  /** A staff member corrected it in Studio. */
  'staff_entry',
  /** The model inferred it; stored only as an inference, never as a fact. */
  'agent_inference',
  /** A system of record reported it (a payment or order API). */
  'system_record',
  'import',
] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

/** Claim status, kept apart from confidence and source authority. */
export const EVIDENCE_STATUSES = ['supported', 'refuted', 'conflicting', 'unknown'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/**
 * Lifecycle. `active` may be used; `pending` waits for review and is never used; `superseded` and
 * `outdated` stay in the history. Deleted records leave only a tombstone.
 */
export const MEMORY_STATUSES = ['active', 'pending', 'superseded', 'outdated'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** `auto`: accepted by the write policy; `confirmed`: by the customer or staff; `pending`. */
export const REVIEW_STATUSES = ['auto', 'confirmed', 'pending'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Stored sensitivity. Special categories (health, religion, ethnicity, sexual orientation,
 * political views) and secrets (passwords, account numbers) are refused, so they never appear.
 */
export const MEMORY_SENSITIVITIES = ['normal', 'personal'] as const;
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

/** What a record may be used for. */
export const MEMORY_PURPOSES = ['ai_replies', 'staff_context'] as const;
export type MemoryPurpose = (typeof MEMORY_PURPOSES)[number];

/** Who may read a record besides its subject. */
export const MEMORY_ROLES = ['customer', 'staff', 'ai'] as const;
export type MemoryRole = (typeof MEMORY_ROLES)[number];

/** Who or what wrote a record. */
export const MEMORY_WRITERS = ['customer', 'staff', 'ai', 'system'] as const;
export type MemoryWriterType = (typeof MEMORY_WRITERS)[number];

/** Retention classes and their lengths in days. */
export const RETENTION_DAYS = { short: 30, medium: 180, long: 365 } as const;
export type RetentionClass = keyof typeof RETENTION_DAYS;

export function retentionClassOf(days: number): RetentionClass {
  if (days <= RETENTION_DAYS.short) return 'short';
  if (days <= RETENTION_DAYS.medium) return 'medium';
  return 'long';
}

/** Why a record was written (a code; free text from staff is kept separately and deleted with it). */
export const WRITE_REASONS = [
  'extracted_from_message',
  'customer_correction',
  'customer_confirmation',
  'staff_correction',
  'staff_confirmation',
] as const;
export type WriteReason = (typeof WRITE_REASONS)[number];

/** How sure the writer was. `stated`: the customer said it; `confirmed`: a person confirmed it. */
export interface MemoryConfidence {
  category: 'stated' | 'confirmed' | 'inferred';
  /** What the model reported, if a model proposed it. Informational only. */
  reported?: 'high' | 'medium' | 'low';
}

/** The memory envelope (blueprint §22), as the domain sees one record. */
export interface MemoryEnvelope {
  id: string;
  tenantId: string;
  brandId: string;
  /** The customer principal the record is about. */
  subjectId: string;
  conversationId: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  /** The slot (`preferred_language`); corrections supersede records of the same slot. */
  key: string;
  value: string;
  sourceType: MemorySourceType;
  sourceEventIds: string[];
  evidenceStatus: EvidenceStatus;
  writtenBy: { type: MemoryWriterType; id: string | null };
  writeReason: WriteReason;
  purpose: string;
  allowedPurposes: MemoryPurpose[];
  allowedRoles: MemoryRole[];
  sensitivity: MemorySensitivity;
  retentionClass: RetentionClass;
  expiresAt: Date | null;
  policyVersion: string;
  status: MemoryStatus;
  reviewStatus: ReviewStatus;
  confidence: MemoryConfidence;
  /** Position in the slot's chain of versions, starting at 1. */
  version: number;
  supersedesId: string | null;
  supersededById: string | null;
  /** Event time: when the source was observed. */
  observedAt: Date;
  /** Event time: from when the value holds. */
  validFrom: Date;
  validUntil: Date | null;
  /** Transaction time: when Hamnivo stored it, and when it stopped being current. */
  recordedAt: Date;
  supersededAt: Date | null;
  lastConfirmedAt: Date | null;
}
