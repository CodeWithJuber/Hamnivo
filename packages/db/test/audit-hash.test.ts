import { describe, expect, it } from 'vitest';
import { AUDIT_GENESIS, AUDIT_REDACTED, auditHash, redactAuditData } from '../src/audit.js';

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

describe('audit data redaction', () => {
  it('never keeps a credential, at any depth, and leaves everything else alone', () => {
    expect(
      redactAuditData({
        kind: 'sso',
        clientSecret: 's3cret',
        oidc: { client_secret: 'x', clientId: 'hamnivo', tokenEndpoint: 'https://idp/token' },
        attempts: [{ password: 'p', newPassword: 'q', apiKey: 'k', token: 't' }],
        inputTokens: 12,
        secretId: 'sec_1',
        webhookSecretId: 'sec_2',
        at: '2026-09-27T00:00:00.000Z',
        nothing: null,
      }),
    ).toEqual({
      kind: 'sso',
      clientSecret: AUDIT_REDACTED,
      oidc: {
        client_secret: AUDIT_REDACTED,
        clientId: 'hamnivo',
        tokenEndpoint: 'https://idp/token',
      },
      attempts: [
        {
          password: AUDIT_REDACTED,
          newPassword: AUDIT_REDACTED,
          apiKey: AUDIT_REDACTED,
          token: AUDIT_REDACTED,
        },
      ],
      inputTokens: 12,
      secretId: 'sec_1',
      webhookSecretId: 'sec_2',
      at: '2026-09-27T00:00:00.000Z',
      nothing: null,
    });
  });
});
