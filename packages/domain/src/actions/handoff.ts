import { plainText } from './schema.js';

/**
 * The handoff packet (G10, HNV-10-03): what the person taking over needs, from Hamnivo's records
 * only: why the AI stepped back, what it tried, what is still pending (actions and approvals), and
 * the customer facts it relied on, each with its source. It is a summary of recorded facts, never
 * hidden reasoning, and it lives in the staff lane (a private note and the inbox).
 */

export interface HandoffAttempt {
  kind: 'knowledge' | 'tool' | 'guard' | 'model' | 'decision';
  label: string;
  outcome: string;
}

export interface HandoffPending {
  actionId: string;
  title: string;
  state: 'awaiting_approval' | 'approved' | 'executing' | 'unknown' | 'superseded';
  approver: 'customer' | 'staff' | null;
  expiresAt: string | null;
}

export interface HandoffFact {
  label: string;
  value: string;
  source: {
    kind: 'tool' | 'memory' | 'identity' | 'language' | 'order';
    /** Public reference of the record (act_…, mem_…, ord_…), when there is one. */
    ref: string | null;
    observedAt: string | null;
  };
}

export interface HandoffPacket {
  version: 1;
  reason: string;
  reasonText: string;
  /** The customer's latest request, as they wrote it (shortened). */
  request: string | null;
  replyLanguage: string | null;
  attempts: HandoffAttempt[];
  pending: HandoffPending[];
  facts: HandoffFact[];
}

export const HANDOFF_LIMITS = { attempts: 12, pending: 10, facts: 12, text: 300 } as const;

/** Bounds every list and text so a packet stays readable and safe to store. */
export function boundedPacket(packet: HandoffPacket): HandoffPacket {
  const text = (value: string) => plainText(value, HANDOFF_LIMITS.text);
  return {
    version: 1,
    reason: packet.reason.slice(0, 60),
    reasonText: text(packet.reasonText),
    request: packet.request ? text(packet.request) : null,
    replyLanguage: packet.replyLanguage?.slice(0, 35) ?? null,
    attempts: packet.attempts.slice(-HANDOFF_LIMITS.attempts).map((a) => ({
      kind: a.kind,
      label: text(a.label),
      outcome: text(a.outcome),
    })),
    pending: packet.pending.slice(0, HANDOFF_LIMITS.pending).map((p) => ({
      ...p,
      title: text(p.title),
    })),
    facts: packet.facts.slice(0, HANDOFF_LIMITS.facts).map((f) => ({
      label: text(f.label),
      value: text(f.value),
      source: f.source,
    })),
  };
}

const PENDING_WORDS: Record<HandoffPending['state'], string> = {
  awaiting_approval: 'waiting for approval',
  approved: 'approved, about to be sent',
  executing: 'sent, waiting for the result',
  unknown: 'result not confirmed yet, being checked',
  superseded:
    'was waiting for approval; cancelled by this handoff, propose it again if still needed',
};

const SOURCE_WORDS: Record<HandoffFact['source']['kind'], string> = {
  tool: 'tool result',
  memory: 'customer memory',
  identity: 'verified by the website',
  language: 'language setting',
  order: 'order record',
};

const time = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : null);

/** The packet as a private note (plain text, in the operator's language: English). */
export function renderHandoffNote(packet: HandoffPacket): string {
  const lines: string[] = [`Handoff: ${packet.reasonText}`];
  if (packet.request) lines.push(`Customer's latest request: “${packet.request}”`);
  if (packet.replyLanguage) lines.push(`Reply language: ${packet.replyLanguage}`);
  if (packet.attempts.length) {
    lines.push('', 'What the AI did:');
    for (const a of packet.attempts) lines.push(`- ${a.label}: ${a.outcome}`);
  }
  if (packet.pending.length) {
    lines.push('', 'Pending actions and approvals:');
    for (const p of packet.pending) {
      const who = p.approver
        ? ` (${p.approver === 'customer' ? 'customer' : 'staff'} approves)`
        : '';
      const until =
        p.state === 'awaiting_approval' && p.expiresAt ? `, until ${time(p.expiresAt)}` : '';
      lines.push(`- ${p.title}: ${PENDING_WORDS[p.state]}${who}${until}`);
    }
    lines.push(
      'Do not repeat an action that was sent; Hamnivo keeps checking and posts the result.',
    );
  }
  if (packet.facts.length) {
    lines.push('', 'Customer facts:');
    for (const f of packet.facts) {
      const when = time(f.source.observedAt);
      lines.push(
        `- ${f.label}: ${f.value} (${SOURCE_WORDS[f.source.kind]}${when ? `, ${when}` : ''})`,
      );
    }
  }
  return lines.join('\n');
}
