import { describe, expect, it } from 'vitest';
import {
  hasWhmcsPermission,
  ownedByWhmcsClient,
  WHMCS_SPEC,
  whmcsPublicFields,
  whmcsSubject,
} from '../src/connectors/whmcs.js';

describe('WHMCS trust boundary', () => {
  it('isolates users and selected clients and never promotes legacy numeric subjects', () => {
    expect(whmcsSubject('whmcs:u:4:c:17')).toEqual({ userId: 4, clientId: 17 });
    expect(whmcsSubject('whmcs:u:5:c:17')).toEqual({ userId: 5, clientId: 17 });
    expect(whmcsSubject('whmcs:u:4:c:18')).toEqual({ userId: 4, clientId: 18 });
    for (const subject of [
      '17',
      'whmcs:u:0:c:17',
      'whmcs:u:4:c:017',
      'whmcs:u:9007199254740992:c:1',
      'whmcs:u:1:c:2:admin',
    ])
      expect(whmcsSubject(subject)).toBeNull();
  });
  it('requires explicit permission, not success or an inferred owner role', () => {
    expect(hasWhmcsPermission({ result: 'success' }, 'invoices')).toBe(false);
    expect(
      hasWhmcsPermission({ result: 'success', permissions: ['invoices', {}] }, 'invoices'),
    ).toBe(false);
    expect(hasWhmcsPermission({ result: 'success', owner: true }, 'invoices')).toBe(false);
    expect(hasWhmcsPermission({ result: 'success', permissions: 'invoices' }, 'invoices')).toBe(
      false,
    );
    expect(
      hasWhmcsPermission(
        { result: 'success', permissions: { permission: ['invoices'] } },
        'invoices',
      ),
    ).toBe(true);
    expect(hasWhmcsPermission({ result: 'success', permissions: ['tickets'] }, 'invoices')).toBe(
      false,
    );
    expect(hasWhmcsPermission({ result: 'error', permissions: ['invoices'] }, 'invoices')).toBe(
      false,
    );
  });
  it('refuses missing, foreign and contradictory ownership', () => {
    expect(ownedByWhmcsClient({ result: 'success', userid: '17' }, 17)).toBe(true);
    for (const row of [
      { result: 'success' },
      { result: 'success', userid: 18 },
      { result: 'success', userid: 17, clientid: 18 },
      { result: 'error', userid: 17 },
      { result: 'success', userid: true },
    ])
      expect(ownedByWhmcsClient(row, 17)).toBe(false);
  });
  it('only returns named public scalar fields', () => {
    expect(
      whmcsPublicFields(
        {
          id: 5,
          name: '<b>Hosting</b>',
          password: 'secret',
          notes: 'private',
          nested: { apiKey: 'secret' },
        },
        ['id', 'name', 'nested'],
      ),
    ).toEqual({ id: 5, name: 'Hosting' });
  });
  it('requires confirmation for payment links, staff for upgrades/cancellation, and never calls a refund API', () => {
    expect(WHMCS_SPEC['invoice.payment_url'].risk).toBe('write');
    expect(WHMCS_SPEC['upgrade.request'].approver).toBe('staff');
    expect(WHMCS_SPEC['cancellation.request'].risk).toBe('irreversible');
    expect(WHMCS_SPEC['refund.handoff'].api).toBeNull();
  });
});
