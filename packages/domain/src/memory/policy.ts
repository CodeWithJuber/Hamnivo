import {
  type EvidenceStatus,
  type MemoryConfidence,
  type MemoryKind,
  type MemoryPurpose,
  type MemoryRole,
  type MemorySensitivity,
  type MemorySourceType,
  type MemoryStatus,
  type MemoryWriterType,
  type RetentionClass,
  type ReviewStatus,
  retentionClassOf,
  type WriteReason,
} from './envelope.js';
import { cleanMemoryValue, quoteAppearsIn, sameMemoryValue } from './normalize.js';
import {
  CATEGORY_NAMES,
  inspectMemoryText,
  SECRET_CATEGORIES,
  SENSITIVE_CATEGORIES,
  type SensitiveCategory,
  type TextFinding,
} from './sensitive.js';
import { type MemorySlot, memorySlot } from './slots.js';
import { coveringTombstone, type TombstoneFact } from './tombstones.js';

/**
 * The independent memory-write policy (L07). The conversational model only proposes; this pure,
 * deterministic function decides whether anything is written, and why. It covers consent,
 * sensitive categories and secrets, provenance and confidence, retention, deletion tombstones and
 * how a new value relates to what is already remembered. Every decision carries its checks and a
 * plain explanation that contains no remembered content.
 */
export const MEMORY_POLICY_VERSION = 'memory-write/1';

/** Active memories one customer can have per brand. */
export const MAX_ACTIVE_MEMORIES = 50;
/** Proposals considered from one conversation turn. */
export const MAX_PROPOSALS_PER_TURN = 10;

const DAY_MS = 86_400_000;

export type MemoryWriter =
  /** The conversational model, proposing from the conversation. Untrusted. */
  | { kind: 'extractor'; agentId: string | null }
  /** The customer the memory is about, through the memory controls. */
  | { kind: 'customer'; principalId: string }
  /** A staff member; `authorized` says the caller checked memory.manage for this brand. */
  | { kind: 'staff'; staffId: string; authorized: boolean };

/** `propose` a new value (extractor); `correct` a current value; `confirm` a value under review. */
export type MemoryOperation = 'propose' | 'correct' | 'confirm';

export interface ProposedMemory {
  key: string;
  value: string;
  /** Words quoted from the customer's message. */
  evidence?: string | null;
  /** The messages the evidence comes from. */
  sourceRefs?: readonly string[];
  confidence?: 'high' | 'medium' | 'low' | null;
  /** `stated`: the customer said it. `inferred`: the model concluded it. */
  basis?: 'stated' | 'inferred' | null;
  /** The proposer's own view of sensitivity; it can only make the decision stricter. */
  sensitivity?: string | null;
}

export interface EvidenceSource {
  ref: string;
  authorKind: 'customer' | 'staff' | 'ai' | 'system';
  /** Written by the customer the memory is about. */
  bySubject: boolean;
  observedAt: Date;
  text: string | null;
}

export type ConsentDecision = 'granted' | 'declined' | 'withdrawn' | 'none';

export interface ExistingMemory {
  id: string;
  key: string;
  value: string;
  status: MemoryStatus;
  version: number;
  validFrom: Date;
}

export interface MemoryWriteInput {
  operation: MemoryOperation;
  writer: MemoryWriter;
  subject: { id: string; verified: boolean; brandId: string };
  context: {
    brandId: string;
    /** The assistant answering this brand uses memory (for proposals). */
    memoryEnabled: boolean;
    /** The customer of the conversation the evidence comes from (for proposals). */
    conversationSubjectId?: string | null;
  };
  consent: { state: ConsentDecision; decidedAt: Date | null };
  candidate: ProposedMemory;
  /** The conversation's messages the proposal may cite, resolved by the caller. */
  sources: readonly EvidenceSource[];
  /** The subject's records in the candidate's slot, whatever their status. */
  existing: readonly ExistingMemory[];
  /** The record a correction or confirmation acts on. */
  target?: ExistingMemory | null;
  /** Active records the subject has now. */
  activeCount: number;
  tombstones: readonly TombstoneFact[];
  /** Keyed fingerprints of the candidate value (computed by the caller). */
  fingerprints: readonly string[];
  now: Date;
  /** When a correction takes effect ("changed yesterday"); defaults to now. */
  validFrom?: Date | null;
}

export type MemoryWriteOutcome = 'write' | 'supersede' | 'review' | 'unchanged' | 'refuse';

export const MEMORY_REFUSALS = [
  'memory_disabled',
  'writer_not_allowed',
  'subject_mismatch',
  'consent_missing',
  'consent_declined',
  'consent_withdrawn',
  'evidence_before_consent',
  'slot_unknown',
  'slot_not_extractable',
  'value_empty',
  'value_too_long',
  'sensitive_category',
  'secret_value',
  'authority_claim',
  'instruction_like',
  'identity_required',
  'no_evidence',
  'evidence_not_from_subject',
  'evidence_not_found',
  'inferred_not_allowed',
  'low_confidence',
  'evidence_expired',
  'deleted_before',
  'subject_limit',
  'review_pending',
  'target_not_current',
  'invalid_validity',
] as const;
export type MemoryRefusal = (typeof MEMORY_REFUSALS)[number];

export type PolicyRule =
  | 'writer'
  | 'subject'
  | 'consent'
  | 'slot'
  | 'value'
  | 'sensitivity'
  | 'authority'
  | 'identity'
  | 'provenance'
  | 'confidence'
  | 'retention'
  | 'tombstone'
  | 'state';

export interface PolicyCheck {
  rule: PolicyRule;
  outcome: 'pass' | 'fail' | 'skip';
  code?: MemoryRefusal;
  /** Category or rule names; never remembered content. */
  detail?: string;
}

/** Everything the policy sets on a record. None of it comes from the proposal. */
export interface MemoryRecordPlan {
  key: string;
  kind: MemoryKind;
  scope: 'person' | 'conversation';
  value: string;
  purpose: string;
  allowedPurposes: MemoryPurpose[];
  allowedRoles: MemoryRole[];
  sensitivity: MemorySensitivity;
  retentionClass: RetentionClass;
  expiresAt: Date;
  sourceType: MemorySourceType;
  sourceEventIds: string[];
  evidenceStatus: EvidenceStatus;
  writtenBy: { type: MemoryWriterType; id: string | null };
  writeReason: WriteReason;
  status: 'active' | 'pending';
  reviewStatus: ReviewStatus;
  confidence: MemoryConfidence;
  observedAt: Date;
  validFrom: Date;
}

export interface MemoryWriteDecision {
  outcome: MemoryWriteOutcome;
  policyVersion: string;
  refusals: MemoryRefusal[];
  checks: PolicyCheck[];
  /** Plain words for people and audit; no remembered content. */
  explanation: string;
  /** What to store for write, supersede and review. */
  record: MemoryRecordPlan | null;
  /** The record the new value supersedes, confirms against, conflicts with or matches. */
  relatedId: string | null;
  /** What the content checks found (categories and rules only). */
  findings: TextFinding[];
}

const REFUSAL_TEXT: Record<MemoryRefusal, string> = {
  memory_disabled: 'This assistant does not use memory.',
  writer_not_allowed: 'This writer may not make this change.',
  subject_mismatch: 'It would be remembered about someone other than this customer.',
  consent_missing: 'The customer has not agreed to be remembered.',
  consent_declined: 'The customer chose not to be remembered.',
  consent_withdrawn: 'The customer turned memory off.',
  evidence_before_consent: 'The customer said it before agreeing to be remembered.',
  slot_unknown: 'This is not something Hamnivo remembers.',
  slot_not_extractable: 'The assistant may not propose this kind of memory.',
  value_empty: 'The value is empty.',
  value_too_long: 'The value is too long.',
  sensitive_category: 'Sensitive personal information is never remembered.',
  secret_value: 'Passwords, security codes and account or card numbers are never remembered.',
  authority_claim: 'Memory cannot grant roles, permissions or entitlements.',
  instruction_like: 'Instructions to the assistant are never remembered.',
  identity_required: 'This is remembered only for customers who are signed in.',
  no_evidence: 'No message from the customer supports it.',
  evidence_not_from_subject: 'Only the customer’s own messages can be evidence.',
  evidence_not_found: 'The quoted words are not in the customer’s message.',
  inferred_not_allowed: 'Only what the customer said is remembered, not what was inferred.',
  low_confidence: 'The proposal was not confident enough.',
  evidence_expired: 'The message is older than this memory may be kept.',
  deleted_before: 'It was deleted before, so it is not remembered again from the same evidence.',
  subject_limit: 'This customer already has as many memories as allowed.',
  review_pending: 'A different value for this already waits for review.',
  target_not_current: 'This memory is no longer current.',
  invalid_validity:
    'A correction cannot take effect before the value it corrects, or later than now.',
};

const isSensitive = (category: string): category is SensitiveCategory =>
  (SENSITIVE_CATEGORIES as readonly string[]).includes(category);

function describe(findings: readonly TextFinding[]): string {
  return [...new Set(findings.map((f) => CATEGORY_NAMES[f.category]))].join(', ');
}

function newest(sources: readonly EvidenceSource[]): Date | null {
  let found: Date | null = null;
  for (const source of sources) {
    if (!found || source.observedAt.getTime() > found.getTime()) found = source.observedAt;
  }
  return found;
}

function writerOf(writer: MemoryWriter): MemoryRecordPlan['writtenBy'] {
  switch (writer.kind) {
    case 'extractor':
      return { type: 'ai', id: writer.agentId };
    case 'customer':
      return { type: 'customer', id: writer.principalId };
    case 'staff':
      return { type: 'staff', id: writer.staffId };
  }
}

function reasonOf(writer: MemoryWriter, operation: MemoryOperation): WriteReason {
  if (writer.kind === 'extractor') return 'extracted_from_message';
  if (writer.kind === 'customer') {
    return operation === 'confirm' ? 'customer_confirmation' : 'customer_correction';
  }
  return operation === 'confirm' ? 'staff_confirmation' : 'staff_correction';
}

function planRecord(
  slot: MemorySlot,
  value: string,
  input: MemoryWriteInput,
  status: 'active' | 'pending',
  cited: readonly EvidenceSource[],
): MemoryRecordPlan {
  const extractor = input.writer.kind === 'extractor';
  const observedAt = extractor ? (newest(cited) ?? input.now) : input.now;
  const validFrom = extractor ? observedAt : (input.validFrom ?? input.now);
  return {
    key: slot.key,
    kind: slot.kind,
    scope: slot.scope,
    value,
    purpose: slot.purpose,
    allowedPurposes: ['ai_replies', 'staff_context'],
    allowedRoles: ['customer', 'staff', 'ai'],
    sensitivity: slot.sensitivity,
    retentionClass: retentionClassOf(slot.retentionDays),
    // Retention runs from the evidence, so a replayed old message cannot extend it.
    expiresAt: new Date(observedAt.getTime() + slot.retentionDays * DAY_MS),
    sourceType: extractor
      ? 'customer_statement'
      : input.writer.kind === 'customer'
        ? 'customer_control'
        : 'staff_entry',
    sourceEventIds: extractor ? cited.map((s) => s.ref) : [],
    evidenceStatus: slot.evidence,
    writtenBy: writerOf(input.writer),
    writeReason: reasonOf(input.writer, input.operation),
    status,
    reviewStatus: status === 'pending' ? 'pending' : extractor ? 'auto' : 'confirmed',
    confidence: extractor
      ? {
          category: 'stated',
          ...(input.candidate.confidence ? { reported: input.candidate.confidence } : {}),
        }
      : { category: 'confirmed' },
    observedAt,
    validFrom,
  };
}

/** Decides one write. Pure: the same input always gives the same decision. */
export function evaluateMemoryWrite(input: MemoryWriteInput): MemoryWriteDecision {
  const checks: PolicyCheck[] = [];
  const pass = (rule: PolicyRule) => checks.push({ rule, outcome: 'pass' });
  const skip = (rule: PolicyRule) => checks.push({ rule, outcome: 'skip' });
  const fail = (rule: PolicyRule, code: MemoryRefusal, detail?: string) =>
    checks.push({ rule, outcome: 'fail', code, ...(detail ? { detail } : {}) });
  const extractor = input.writer.kind === 'extractor';

  // Who writes, and about whom.
  if (input.writer.kind === 'extractor') {
    if (input.operation !== 'propose') fail('writer', 'writer_not_allowed');
    else if (!input.context.memoryEnabled) fail('writer', 'memory_disabled');
    else pass('writer');
  } else if (input.writer.kind === 'customer') {
    if (input.operation === 'propose') fail('writer', 'writer_not_allowed');
    else if (input.writer.principalId !== input.subject.id) fail('writer', 'subject_mismatch');
    else pass('writer');
  } else if (!input.writer.authorized || input.operation === 'propose') {
    fail('writer', 'writer_not_allowed');
  } else {
    pass('writer');
  }
  if (input.subject.brandId !== input.context.brandId) fail('subject', 'subject_mismatch');
  else if (extractor && input.context.conversationSubjectId !== input.subject.id) {
    fail('subject', 'subject_mismatch');
  } else pass('subject');

  // Consent to personal memory, now.
  switch (input.consent.state) {
    case 'granted':
      pass('consent');
      break;
    case 'declined':
      fail('consent', 'consent_declined');
      break;
    case 'withdrawn':
      fail('consent', 'consent_withdrawn');
      break;
    default:
      fail('consent', 'consent_missing');
  }

  // The slot decides what the record is; unknown slots are refused.
  const slot = memorySlot(input.candidate.key);
  if (!slot) fail('slot', 'slot_unknown');
  else if (extractor && !slot.extractable) fail('slot', 'slot_not_extractable');
  else pass('slot');

  const value = cleanMemoryValue(input.candidate.value ?? '');
  if (!value) fail('value', 'value_empty');
  else if (slot && value.length > slot.maxLength) fail('value', 'value_too_long');
  else pass('value');

  // Content checks on the value and its evidence, whoever proposed them.
  const findings = inspectMemoryText(`${value}\n${input.candidate.evidence ?? ''}`);
  const secrets = findings.filter((f) =>
    SECRET_CATEGORIES.includes(f.category as SensitiveCategory),
  );
  const special = findings.filter((f) => isSensitive(f.category) && !secrets.includes(f));
  const proposerFlagged =
    typeof input.candidate.sensitivity === 'string' &&
    !['', 'none', 'normal', 'low', 'personal'].includes(input.candidate.sensitivity.toLowerCase());
  if (secrets.length > 0) fail('sensitivity', 'secret_value', describe(secrets));
  if (special.length > 0) fail('sensitivity', 'sensitive_category', describe(special));
  else if (proposerFlagged && secrets.length === 0) {
    fail('sensitivity', 'sensitive_category', 'flagged by the proposer');
  }
  if (secrets.length === 0 && special.length === 0 && !proposerFlagged) pass('sensitivity');

  const authority = findings.filter((f) => f.category === 'authority_claim');
  const instructions = findings.filter((f) => f.category === 'instruction');
  if (authority.length > 0) fail('authority', 'authority_claim');
  if (instructions.length > 0) fail('authority', 'instruction_like');
  if (authority.length === 0 && instructions.length === 0) pass('authority');

  if (!slot) skip('identity');
  else if (slot.sensitivity === 'personal' && !input.subject.verified) {
    fail('identity', 'identity_required');
  } else pass('identity');

  // Provenance, confidence and retention of proposals: the customer's own words, recently.
  const refs = input.candidate.sourceRefs ?? [];
  const cited = input.sources.filter((s) => refs.includes(s.ref));
  if (extractor) {
    if (refs.length === 0 || cited.length === 0) fail('provenance', 'no_evidence');
    else if (cited.some((s) => !s.bySubject || s.authorKind !== 'customer')) {
      fail('provenance', 'evidence_not_from_subject');
    } else if (
      !input.candidate.evidence ||
      !cited.some((s) => s.text !== null && quoteAppearsIn(input.candidate.evidence ?? '', s.text))
    ) {
      fail('provenance', 'evidence_not_found');
    } else if (input.candidate.basis !== 'stated') fail('provenance', 'inferred_not_allowed');
    else pass('provenance');

    if (input.candidate.confidence === 'high' || input.candidate.confidence === 'medium') {
      pass('confidence');
    } else fail('confidence', 'low_confidence');

    const decidedAt = input.consent.decidedAt?.getTime();
    if (
      input.consent.state === 'granted' &&
      decidedAt !== undefined &&
      cited.some((s) => s.observedAt.getTime() < decidedAt)
    ) {
      fail('consent', 'evidence_before_consent');
    }
    const latest = newest(cited);
    if (slot && latest && latest.getTime() + slot.retentionDays * DAY_MS <= input.now.getTime()) {
      fail('retention', 'evidence_expired');
    } else pass('retention');
  } else {
    skip('provenance');
    skip('confidence');
    pass('retention');
  }

  // A deletion covers the same slot, source or value observed before it.
  const covering = coveringTombstone(
    {
      key: slot?.key ?? input.candidate.key,
      sourceRefs: cited.map((s) => s.ref),
      fingerprints: input.fingerprints,
      observedAt: extractor ? (newest(cited) ?? input.now) : input.now,
    },
    input.tombstones,
  );
  if (covering) fail('tombstone', 'deleted_before', covering.scope);
  else pass('tombstone');

  const decide = (
    outcome: MemoryWriteOutcome,
    record: MemoryRecordPlan | null,
    relatedId: string | null,
  ): MemoryWriteDecision => {
    const refusals = checks.flatMap((c) => (c.outcome === 'fail' && c.code ? [c.code] : []));
    return {
      outcome,
      policyVersion: MEMORY_POLICY_VERSION,
      refusals,
      checks,
      explanation: explain(outcome, refusals, slot, checks),
      record,
      relatedId,
      findings,
    };
  };

  if (checks.some((c) => c.outcome === 'fail') || !slot) return decide('refuse', null, null);

  // How the value relates to what is already remembered in this slot.
  const active = input.existing.find((r) => r.status === 'active' && r.key === slot.key) ?? null;
  const pending = input.existing.find((r) => r.status === 'pending' && r.key === slot.key) ?? null;
  switch (input.operation) {
    case 'propose': {
      if (pending) {
        if (sameMemoryValue(pending.value, value)) {
          pass('state');
          return decide('unchanged', null, pending.id);
        }
        fail('state', 'review_pending');
        return decide('refuse', null, null);
      }
      if (active && sameMemoryValue(active.value, value)) {
        pass('state');
        return decide('unchanged', null, active.id);
      }
      if (active) {
        // New evidence disagrees: nothing is replaced until the customer or staff confirm it.
        pass('state');
        return decide('review', planRecord(slot, value, input, 'pending', cited), active.id);
      }
      if (input.activeCount >= MAX_ACTIVE_MEMORIES) {
        fail('state', 'subject_limit');
        return decide('refuse', null, null);
      }
      pass('state');
      return decide('write', planRecord(slot, value, input, 'active', cited), null);
    }
    case 'correct': {
      const target = input.target ?? null;
      if (target?.status !== 'active' || target.key !== slot.key) {
        fail('state', 'target_not_current');
        return decide('refuse', null, null);
      }
      if (sameMemoryValue(target.value, value)) {
        pass('state');
        return decide('unchanged', null, target.id);
      }
      const validFrom = input.validFrom ?? input.now;
      if (
        validFrom.getTime() > input.now.getTime() ||
        validFrom.getTime() < target.validFrom.getTime()
      ) {
        fail('state', 'invalid_validity');
        return decide('refuse', null, null);
      }
      pass('state');
      return decide('supersede', planRecord(slot, value, input, 'active', []), target.id);
    }
    case 'confirm': {
      const target = input.target ?? null;
      if (target?.status !== 'pending' || target.key !== slot.key) {
        fail('state', 'target_not_current');
        return decide('refuse', null, null);
      }
      pass('state');
      return decide('supersede', planRecord(slot, value, input, 'active', []), active?.id ?? null);
    }
  }
}

function explain(
  outcome: MemoryWriteOutcome,
  refusals: readonly MemoryRefusal[],
  slot: MemorySlot | null,
  checks: readonly PolicyCheck[],
): string {
  const label = slot?.label.toLowerCase() ?? 'this';
  switch (outcome) {
    case 'write':
      return `Remembered: ${label}.`;
    case 'supersede':
      return `Remembered: the new ${label} replaces the previous one, which stays in the history.`;
    case 'review':
      return `Needs review: the new ${label} differs from what is remembered, so both are kept until someone confirms which is right.`;
    case 'unchanged':
      return `Unchanged: this ${label} is already remembered.`;
    case 'refuse': {
      const sentences = [...new Set(refusals)].map((code) => {
        const detail = checks.find((c) => c.code === code)?.detail;
        if (code === 'sensitive_category' && detail && detail !== 'flagged by the proposer') {
          return `It looks like ${detail}, which is never remembered.`;
        }
        return REFUSAL_TEXT[code];
      });
      return `Not remembered. ${sentences.join(' ')}`;
    }
  }
}

/** The plain-language reason for one refusal code. */
export function memoryRefusalText(code: MemoryRefusal): string {
  return REFUSAL_TEXT[code];
}
