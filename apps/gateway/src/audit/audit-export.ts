import type { schema } from '@hamnivo/db';

type AuditRow = typeof schema.auditEvents.$inferSelect;

export const CSV_COLUMNS = [
  'seq',
  'id',
  'occurred_at',
  'actor_type',
  'actor_id',
  'action',
  'target_type',
  'target_id',
  'outcome',
  'reason',
  'request_id',
  'data',
  'prev_hash',
  'hash',
] as const;

/**
 * One CSV field (RFC 4180). Text that a spreadsheet would run as a formula (starting with =, +,
 * -, @, tab or carriage return) is prefixed with an apostrophe: audit text includes names and
 * reasons people typed.
 */
export function csvField(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvHeader(): string {
  return `${CSV_COLUMNS.join(',')}\r\n`;
}

export function csvRow(event: AuditRow): string {
  return `${[
    event.seq,
    event.id,
    event.occurredAt.toISOString(),
    event.actorType,
    event.actorId,
    event.action,
    event.targetType,
    event.targetId,
    event.outcome,
    event.reason,
    event.requestId,
    JSON.stringify(event.data),
    event.prevHash.toString('hex'),
    event.hash.toString('hex'),
  ]
    .map(csvField)
    .join(',')}\r\n`;
}

/** One NDJSON line, with the hashes so the chain can be checked outside Hamnivo. */
export function ndjsonLine(event: AuditRow): string {
  return `${JSON.stringify({
    seq: event.seq,
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    actor: { type: event.actorType, id: event.actorId },
    action: event.action,
    target: event.targetType ? { type: event.targetType, id: event.targetId } : null,
    outcome: event.outcome,
    reason: event.reason,
    requestId: event.requestId,
    data: event.data,
    prevHash: event.prevHash.toString('hex'),
    hash: event.hash.toString('hex'),
  })}\n`;
}
