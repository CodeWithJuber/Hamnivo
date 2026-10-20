import { describe, expect, it } from 'vitest';
import { AgencyClient, agencyRoutes, UpdateAgencySettingsRequest } from '../src/agency.js';

describe('agency API contract', () => {
  it('rejects empty settings changes and invalid branding', () => {
    expect(UpdateAgencySettingsRequest.safeParse({}).success).toBe(false);
    expect(
      UpdateAgencySettingsRequest.safeParse({ branding: { accentColor: 'red' } }).success,
    ).toBe(false);
    expect(
      UpdateAgencySettingsRequest.safeParse({ branding: { accentColor: '#a1B2c3' } }).success,
    ).toBe(true);
  });

  it('keeps client links typed as tenant metadata with an explicit access indicator', () => {
    const row = {
      tenant: {
        id: 'tnt_01j9zk7w3xq8r4t2v6m5n1p0cd',
        slug: 'client-one',
        name: 'Client One',
        status: 'active',
      },
      linkedAt: new Date().toISOString(),
      canAccess: false,
    };
    expect(AgencyClient.safeParse(row).success).toBe(true);
    expect(AgencyClient.safeParse({ ...row, canAccess: undefined }).success).toBe(false);
  });

  it('documents creation and linking as separate routes', () => {
    expect(agencyRoutes.createAgencyClient.path).toBe('/v1/admin/agency/clients');
    expect(agencyRoutes.createAgencyClient.idempotent).toBe(true);
    expect(agencyRoutes.linkAgencyClient.path).toBe('/v1/admin/agency/clients/link');
  });
});
