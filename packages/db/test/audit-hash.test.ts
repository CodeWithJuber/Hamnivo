import { describe, expect, it } from 'vitest';
import { AUDIT_GENESIS, auditHash } from '../src/audit.js';

const record = {
  v: 1 as const,
  tenantId: '0192f8a4-6b5e-7c3d-8e9f-0a1b2c3d4e5f',
  seq: 1,
  id: '0192f8a4-6b5e-7c3d-8e9f-0a1b2c3d4e60',
  occurredAt: '2026-09-26T19:00:00.000Z',
  actorType: 'staff',
  actorId: 'stf_1',
  action: 'grant.created',
  targetType: 'grant',
  targetId: 'grt_1',
  outcome: 'success',
  reason: null,
  requestId: 'req_1',
  data: { role: 'admin', scope: { type: 'tenant' } },
};

describe('audit hash chain', () => {
  it('is independent of object key order (RFC 8785 canonical JSON)', () => {
    const reordered = { ...record, data: { scope: { type: 'tenant' }, role: 'admin' } };
    expect(auditHash(AUDIT_GENESIS, reordered).equals(auditHash(AUDIT_GENESIS, record))).toBe(true);
  });

  it('changes when any field or the previous hash changes', () => {
    const base = auditHash(AUDIT_GENESIS, record);
    expect(auditHash(AUDIT_GENESIS, { ...record, outcome: 'denied' }).equals(base)).toBe(false);
    expect(auditHash(Buffer.alloc(32, 1), record).equals(base)).toBe(false);
    expect(base).toHaveLength(32);
  });
});
