import { describe, expect, it } from 'vitest';
import {
  authorize,
  authorizeAny,
  checkDelegation,
  diffPermissions,
  effectivePermissions,
  explain,
  type Grant,
  inapplicablePermissions,
  PERMISSION_KEYS,
  presetPermissions,
  ROLE_PRESETS,
  type ScopeHierarchy,
  type ServiceAccountPrincipal,
  type StaffPrincipal,
  validatePatterns,
} from '../src/index.js';

const now = new Date('2026-09-26T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

// Workspace W contains brand B, which contains inbox I. Team T is orthogonal.
const hierarchy: ScopeHierarchy = (scope) => {
  switch (scope.type) {
    case 'brand':
      return { workspaceId: 'W' };
    case 'inbox':
      return { workspaceId: 'W', brandId: 'B' };
    default:
      return {};
  }
};

const grant = (overrides: Partial<Grant> & Pick<Grant, 'permissions' | 'scope'>): Grant => ({
  id: `g_${Math.random().toString(36).slice(2, 8)}`,
  expiresAt: null,
  revokedAt: null,
  ...overrides,
});

const staff = (grants: Grant[], overrides: Partial<StaffPrincipal> = {}): StaffPrincipal => ({
  kind: 'staff',
  tenantId: 't1',
  staffMemberId: 's1',
  status: 'active',
  mfa: false,
  authenticatedAt: minutesAgo(1),
  grants,
  ...overrides,
});

describe('catalog and presets', () => {
  it('uses only valid permission patterns in presets', () => {
    for (const preset of ROLE_PRESETS) expect(validatePatterns(preset.patterns)).toEqual([]);
    expect(validatePatterns(['conversations.read', 'nope.read', 'ghost.*'])).toEqual([
      'nope.read',
      'ghost.*',
    ]);
  });

  it('gives the owner everything and keeps billing away from admins and agents', () => {
    expect(presetPermissions('owner')).toEqual(PERMISSION_KEYS);
    expect(presetPermissions('admin')).not.toContain('billing.manage');
    expect(presetPermissions('agent')).not.toContain('billing.manage');
    expect(presetPermissions('agent')).toContain('conversations.takeover');
  });
});

describe('authorize', () => {
  const agentOnTeam = grant({
    permissions: presetPermissions('agent'),
    scope: { type: 'team', id: 'T' },
  });

  it('allows within the grant scope and names the reason otherwise', () => {
    const p = staff([agentOnTeam]);
    expect(authorize(p, 'conversations.reply', { teamId: 'T' }, { now })).toEqual({
      allowed: true,
      grantId: agentOnTeam.id,
    });
    expect(authorize(p, 'conversations.reply', { teamId: 'T2' }, { now })).toMatchObject({
      allowed: false,
      reason: 'outside_scope',
    });
    expect(authorize(p, 'billing.manage', {}, { now })).toMatchObject({ reason: 'no_grant' });
  });

  it('ignores revoked and expired grants and inactive people', () => {
    expect(
      authorize(
        staff([{ ...agentOnTeam, revokedAt: minutesAgo(5) }]),
        'conversations.read',
        { teamId: 'T' },
        { now },
      ),
    ).toMatchObject({ reason: 'no_grant' });
    expect(
      authorize(
        staff([{ ...agentOnTeam, expiresAt: minutesAgo(1) }]),
        'conversations.read',
        { teamId: 'T' },
        { now },
      ),
    ).toMatchObject({ reason: 'no_grant' });
    expect(
      authorize(
        staff([agentOnTeam], { status: 'suspended' }),
        'conversations.read',
        { teamId: 'T' },
        { now },
      ),
    ).toMatchObject({ reason: 'inactive_principal' });
  });

  it('requires MFA and a fresh sign-in for sensitive actions', () => {
    const admin = grant({ permissions: ['*'], scope: { type: 'tenant' } });
    expect(authorize(staff([admin]), 'commerce.refund', { brandId: 'B' }, { now })).toMatchObject({
      reason: 'mfa_required',
    });
    expect(
      authorize(
        staff([admin], { mfa: true, authenticatedAt: minutesAgo(60) }),
        'commerce.refund',
        { brandId: 'B' },
        { now },
      ),
    ).toMatchObject({ reason: 'step_up_required' });
    expect(
      authorize(staff([admin], { mfa: true }), 'commerce.refund', { brandId: 'B' }, { now })
        .allowed,
    ).toBe(true);
    // Non-sensitive actions don't need a fresh session.
    expect(
      authorize(
        staff([admin], { authenticatedAt: minutesAgo(600) }),
        'conversations.read',
        {},
        { now },
      ).allowed,
    ).toBe(true);
  });

  it('lets API keys narrow, never widen, a service account', () => {
    const service: ServiceAccountPrincipal = {
      kind: 'service_account',
      tenantId: 't1',
      serviceAccountId: 'sa1',
      status: 'active',
      keyScopes: ['conversations.read'],
      grants: [
        grant({ permissions: ['conversations.*', 'secrets.manage'], scope: { type: 'tenant' } }),
      ],
    };
    expect(authorize(service, 'conversations.read', {}, { now }).allowed).toBe(true);
    expect(authorize(service, 'conversations.reply', {}, { now })).toMatchObject({
      reason: 'key_scope',
    });
    expect(
      authorize({ ...service, keyScopes: ['*'] }, 'secrets.manage', {}, { now }),
    ).toMatchObject({
      reason: 'mfa_required',
    });
    expect(
      authorize({ ...service, keyScopes: ['*'] }, 'billing.manage', {}, { now }),
    ).toMatchObject({
      reason: 'no_grant',
    });
  });

  it('explains denials in plain language with a remedy', () => {
    const decision = authorize(staff([agentOnTeam]), 'billing.manage', {}, { now });
    expect(explain(decision)).toMatchObject({ allowed: false, key: 'policy.no_grant' });
    expect(effectivePermissions(staff([agentOnTeam]), now).has('conversations.reply')).toBe(true);
  });
});

describe('authorizeAny', () => {
  it('allows a scoped grant for list screens but keeps MFA and freshness rules', () => {
    const scoped = staff([
      grant({
        permissions: ['conversations.read', 'secrets.manage'],
        scope: { type: 'workspace', id: 'W' },
      }),
    ]);
    expect(authorize(scoped, 'conversations.read', {}, { now }).allowed).toBe(false);
    expect(authorizeAny(scoped, 'conversations.read', { now }).allowed).toBe(true);
    expect(authorizeAny(scoped, 'secrets.manage', { now })).toMatchObject({
      reason: 'mfa_required',
    });
    expect(authorizeAny(scoped, 'billing.manage', { now })).toMatchObject({ reason: 'no_grant' });
  });
});

describe('delegation ceiling', () => {
  const supervisorGrant = grant({
    permissions: presetPermissions('supervisor'),
    scope: { type: 'team', id: 'T' },
    expiresAt: inDays(7),
  });
  const supervisor = staff([supervisorGrant], { staffMemberId: 'sup', mfa: true });

  it('allows handing out a subset of your own access inside your scope', () => {
    const problems = checkDelegation(
      supervisor,
      {
        granteeStaffMemberId: 'new',
        permissions: ['conversations.read', 'conversations.reply'],
        scope: { type: 'team', id: 'T' },
        expiresAt: inDays(3),
      },
      hierarchy,
      now,
    );
    expect(problems).toEqual([]);
  });

  it('blocks escalation, other scopes, self-grants and longer expiry', () => {
    const problems = checkDelegation(
      supervisor,
      {
        granteeStaffMemberId: 'sup',
        permissions: ['conversations.read', 'billing.manage'],
        scope: { type: 'team', id: 'T2' },
        expiresAt: null,
      },
      hierarchy,
      now,
    );
    const codes = problems.map((p) => p.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'not_allowed',
        'self_grant',
        'outside_own_scope',
        'exceeds_own_permissions',
      ]),
    );

    const longer = checkDelegation(
      supervisor,
      {
        granteeStaffMemberId: 'new',
        permissions: ['conversations.read'],
        scope: { type: 'team', id: 'T' },
        expiresAt: null,
      },
      hierarchy,
      now,
    );
    expect(longer).toEqual([{ code: 'expiry_beyond_own', latest: supervisorGrant.expiresAt }]);
  });

  it('lets a workspace admin delegate to a brand inside that workspace, not outside', () => {
    const wsAdmin = staff(
      [grant({ permissions: presetPermissions('admin'), scope: { type: 'workspace', id: 'W' } })],
      {
        staffMemberId: 'wa',
        mfa: true,
      },
    );
    const inside = checkDelegation(
      wsAdmin,
      {
        granteeStaffMemberId: 'x',
        permissions: ['knowledge.manage'],
        scope: { type: 'brand', id: 'B' },
        expiresAt: null,
      },
      hierarchy,
      now,
    );
    expect(inside).toEqual([]);
    const tenantWide = checkDelegation(
      wsAdmin,
      {
        granteeStaffMemberId: 'x',
        permissions: ['knowledge.manage'],
        scope: { type: 'tenant' },
        expiresAt: null,
      },
      hierarchy,
      now,
    );
    expect(tenantWide.map((p) => p.code)).toContain('outside_own_scope');
  });
});

describe('scope levels', () => {
  it('keeps permissions inert where they do not apply and lets reference data be read anywhere', () => {
    const teamOwner = staff([grant({ permissions: ['*'], scope: { type: 'team', id: 'T' } })]);
    expect(authorize(teamOwner, 'billing.manage', {}, { now })).toMatchObject({
      reason: 'no_grant',
    });
    expect(authorize(teamOwner, 'conversations.reply', { teamId: 'T' }, { now }).allowed).toBe(
      true,
    );
    expect(authorize(teamOwner, 'knowledge.read', { brandId: 'B' }, { now }).allowed).toBe(true);
    expect(
      authorize(teamOwner, 'commerce.read', { brandId: 'B', teamId: 'T' }, { now }).allowed,
    ).toBe(true);
    expect(authorize(teamOwner, 'commerce.read', { brandId: 'B' }, { now })).toMatchObject({
      reason: 'outside_scope',
    });
    expect(effectivePermissions(teamOwner, now).has('billing.manage')).toBe(false);
    expect(inapplicablePermissions(['audit.read', 'conversations.read'], 'team')).toEqual([
      'audit.read',
    ]);
  });

  it('lets a supervisor preset be delegated at team scope', () => {
    const lead = staff(
      [grant({ permissions: presetPermissions('supervisor'), scope: { type: 'team', id: 'T' } })],
      {
        staffMemberId: 'lead',
      },
    );
    const problems = checkDelegation(
      lead,
      {
        granteeStaffMemberId: 'x',
        permissions: presetPermissions('agent'),
        scope: { type: 'team', id: 'T' },
        expiresAt: null,
      },
      hierarchy,
      now,
    );
    expect(problems).toEqual([]);
  });

  it('uses the given manage permission for invitations', () => {
    const inviter = staff([
      grant({ permissions: ['members.invite', 'conversations.read'], scope: { type: 'tenant' } }),
    ]);
    const proposed = {
      granteeStaffMemberId: 'x',
      permissions: ['conversations.read'],
      scope: { type: 'tenant' } as const,
      expiresAt: null,
    };
    expect(checkDelegation(inviter, proposed, hierarchy, now).map((p) => p.code)).toEqual([
      'not_allowed',
    ]);
    expect(checkDelegation(inviter, proposed, hierarchy, now, 'members.invite')).toEqual([]);
  });
});

describe('permission diff', () => {
  it('lists added, removed and newly sensitive permissions', () => {
    const diff = diffPermissions(
      ['conversations.read', 'knowledge.*'],
      ['conversations.*', 'knowledge.read'],
    );
    expect(diff.removed).toEqual(['knowledge.manage']);
    expect(diff.added).toContain('conversations.export');
    expect(diff.addedSensitive).toEqual(['conversations.export']);
  });
});
