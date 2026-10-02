import { describe, expect, it } from 'vitest';
import {
  authorize,
  authorizeActionApproval,
  type Grant,
  presetPermissions,
  type StaffPrincipal,
} from '../src/index.js';

const now = new Date('2026-09-27T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

const staff = (
  preset: Parameters<typeof presetPermissions>[0],
  scope: Grant['scope'],
  overrides: Partial<StaffPrincipal> = {},
): StaffPrincipal => ({
  kind: 'staff',
  tenantId: 't1',
  staffMemberId: 's1',
  status: 'active',
  mfa: true,
  authenticatedAt: minutesAgo(1),
  grants: [
    { id: 'g1', permissions: presetPermissions(preset), scope, expiresAt: null, revokedAt: null },
  ],
  ...overrides,
});

const brand = { brandId: 'B', workspaceId: 'W' };

describe('action approvals by staff', () => {
  it('lets agents and supervisors approve low-risk actions where they work', () => {
    const agent = staff('agent', { type: 'team', id: 'T' });
    expect(
      authorizeActionApproval(
        agent,
        { risk: 'write', requiredPermission: null },
        { teamId: 'T' },
        {
          now,
        },
      ).allowed,
    ).toBe(true);
    expect(
      authorizeActionApproval(
        agent,
        { risk: 'write', requiredPermission: null },
        { teamId: 'X' },
        {
          now,
        },
      ),
    ).toMatchObject({ allowed: false, reason: 'outside_scope' });
  });

  it('needs the tool’s required permission as well', () => {
    const agent = staff('agent', { type: 'tenant' });
    expect(
      authorizeActionApproval(
        agent,
        { risk: 'money', requiredPermission: 'commerce.refunds.approve' },
        brand,
        { now },
      ),
    ).toMatchObject({ allowed: false, reason: 'no_grant', permission: 'commerce.refunds.approve' });
    const lead = staff('supervisor', { type: 'brand', id: 'B' });
    expect(
      authorizeActionApproval(
        lead,
        { risk: 'money', requiredPermission: 'commerce.refunds.approve' },
        brand,
        { now },
      ).allowed,
    ).toBe(true);
  });

  it('asks for a fresh sign-in for money and irreversible actions only', () => {
    const lead = staff('supervisor', { type: 'tenant' }, { authenticatedAt: minutesAgo(30) });
    for (const risk of ['money', 'irreversible'] as const) {
      expect(
        authorizeActionApproval(lead, { risk, requiredPermission: null }, brand, { now }),
      ).toMatchObject({ allowed: false, reason: 'step_up_required' });
    }
    expect(
      authorizeActionApproval(lead, { risk: 'write', requiredPermission: null }, brand, { now })
        .allowed,
    ).toBe(true);
    expect(
      authorizeActionApproval(lead, { risk: 'money', requiredPermission: null }, brand, {
        now,
        stepUpMaxAgeMs: 60 * 60_000,
      }).allowed,
    ).toBe(true);
  });

  it('refuses unknown required permissions and people without tools.approve', () => {
    const lead = staff('supervisor', { type: 'tenant' });
    expect(
      authorizeActionApproval(
        lead,
        { risk: 'write', requiredPermission: 'root.everything' },
        brand,
        {
          now,
        },
      ),
    ).toMatchObject({ allowed: false, reason: 'no_grant' });
    const analyst = staff('analyst', { type: 'tenant' });
    expect(
      authorizeActionApproval(analyst, { risk: 'read', requiredPermission: null }, brand, { now }),
    ).toMatchObject({ allowed: false, reason: 'no_grant', permission: 'tools.approve' });
  });

  it('lets people who approve actions read tool policies, and only admins manage them', () => {
    for (const preset of ['agent', 'supervisor', 'admin'] as const) {
      expect(
        authorize(staff(preset, { type: 'team', id: 'T' }), 'tools.read', brand, { now }).allowed,
      ).toBe(true);
    }
    expect(presetPermissions('agent')).not.toContain('tools.manage');
    expect(presetPermissions('supervisor')).not.toContain('tools.manage');
    expect(presetPermissions('admin')).toContain('tools.manage');
  });
});
