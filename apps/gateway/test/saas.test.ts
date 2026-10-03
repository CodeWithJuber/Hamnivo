import type { StaffPrincipal } from '@hamnivo/policy';
import { describe, expect, it } from 'vitest';
import {
  type AccountState,
  afterPayment,
  afterPaymentFailure,
  afterSubscription,
  graceOver,
} from '../src/billing/lifecycle.js';
import { formatMinor } from '../src/billing/notices.js';
import type { PlanRow } from '../src/billing/plans.js';
import { planForSubscription } from '../src/billing/subscriptions.service.js';
import {
  assertWidgetOnline,
  assertWritable,
  markSuspended,
  readOnlyGrants,
} from '../src/identity/tenants.readonly.js';
import { externalProvider, slugFrom } from '../src/identity/tenants.service.js';
import { renderEmail } from '../src/platform/emails/index.js';
import { addressOf, displayName } from '../src/platform/mailer.js';
import {
  bearerOperatorKey,
  generateOperatorKey,
  OperatorKeyHasher,
  parseOperatorKey,
} from '../src/platform/operator-keys.js';

const DAY = 86_400_000;
const now = new Date('2026-10-03T12:00:00Z');
const clean: AccountState = {
  subscriptionStatus: 'none',
  planKey: null,
  paymentFailedAt: null,
  graceEndsAt: null,
};

describe('subscription lifecycle (A16)', () => {
  it('gives the subscribed plan while trialing or active, and forgets an earlier failure', () => {
    const failed = { ...clean, paymentFailedAt: new Date(now.getTime() - DAY) };
    for (const state of ['trialing', 'active'] as const) {
      expect(afterSubscription(failed, { state, planKey: 'pro' }, now, 7)).toEqual({
        account: {
          subscriptionStatus: state,
          planKey: 'pro',
          paymentFailedAt: null,
          graceEndsAt: null,
        },
        entitlement: 'plan',
      });
    }
    // A price no plan sells: nothing changes rather than a guess.
    expect(afterSubscription(clean, { state: 'active', planKey: null }, now, 7).entitlement).toBe(
      'keep',
    );
  });

  it('keeps the plan during the grace period of a failed payment, then falls back to free', () => {
    const first = afterSubscription(clean, { state: 'past_due', planKey: 'pro' }, now, 7);
    expect(first.entitlement).toBe('plan');
    expect(first.account.paymentFailedAt).toEqual(now);
    expect(first.account.graceEndsAt).toEqual(new Date(now.getTime() + 7 * DAY));
    // The same cycle reported again a day later keeps the first failure and its end.
    const later = new Date(now.getTime() + DAY);
    const again = afterSubscription(first.account, { state: 'past_due', planKey: 'pro' }, later, 7);
    expect(again.account).toEqual(first.account);
    // Past the grace period: the free plan, and no date left for the worker to pick up again.
    const over = new Date(now.getTime() + 8 * DAY);
    const lapsed = afterSubscription(first.account, { state: 'past_due', planKey: 'pro' }, over, 7);
    expect(lapsed.entitlement).toBe('fallback');
    expect(lapsed.account.graceEndsAt).toBeNull();
    expect(lapsed.account.paymentFailedAt).toEqual(now);
    // Reported again after the lapse: still over.
    const reported = afterSubscription(
      lapsed.account,
      { state: 'past_due', planKey: 'pro' },
      over,
      7,
    );
    expect(reported.entitlement).toBe('fallback');
  });

  it('falls back to free when unpaid, canceled or paused, and waits while incomplete', () => {
    for (const state of ['unpaid', 'canceled', 'paused'] as const) {
      expect(afterSubscription(clean, { state, planKey: 'pro' }, now, 7).entitlement).toBe(
        'fallback',
      );
    }
    expect(afterSubscription(clean, { state: 'incomplete', planKey: 'pro' }, now, 7)).toMatchObject(
      {
        entitlement: 'keep',
        account: { subscriptionStatus: 'incomplete' },
      },
    );
  });

  it('starts the grace period once per dunning cycle and ends it with a payment', () => {
    const failed = afterPaymentFailure(clean, now, now, 7);
    expect(failed.graceEndsAt).toEqual(new Date(now.getTime() + 7 * DAY));
    const retried = afterPaymentFailure(failed, new Date(now.getTime() + 2 * DAY), now, 7);
    expect(retried.graceEndsAt).toEqual(failed.graceEndsAt);
    expect(afterPayment(retried)).toMatchObject({ paymentFailedAt: null, graceEndsAt: null });
    const pastDue = { ...failed, subscriptionStatus: 'past_due' as const };
    expect(graceOver(pastDue, now)).toBe(false);
    expect(graceOver(pastDue, new Date(now.getTime() + 7 * DAY))).toBe(true);
    expect(
      graceOver({ ...pastDue, subscriptionStatus: 'active' }, new Date(now.getTime() + 8 * DAY)),
    ).toBe(false);
    // Zero grace days: the plan falls back at the first failure.
    expect(
      afterSubscription(clean, { state: 'past_due', planKey: 'pro' }, now, 0).entitlement,
    ).toBe('fallback');
  });

  it('finds the plan a subscription pays for by its price, else by the plan it started on', () => {
    const plan = (key: string, stripePriceId: string | null): PlanRow => ({
      key,
      name: key,
      currency: 'USD',
      priceMinor: 100n,
      limits: {},
      metered: [],
      trialDays: 0,
      stripePriceId,
    });
    const plans = [plan('free', null), plan('pro', 'price_pro'), plan('team', 'price_team')];
    expect(planForSubscription(plans, { priceRef: 'price_team', planKey: 'pro' })?.key).toBe(
      'team',
    );
    expect(planForSubscription(plans, { priceRef: 'price_gone', planKey: 'pro' })?.key).toBe('pro');
    expect(planForSubscription(plans, { priceRef: 'price_gone', planKey: null })).toBeNull();
  });
});

describe('transactional emails', () => {
  it('renders every template to HTML with React Email and a plain-text fallback', async () => {
    const url = 'https://studio.example/x?token=abc%2Edef';
    const templates = [
      { kind: 'welcome', name: 'Nora', workspace: 'Northwind', studioUrl: url },
      {
        kind: 'invitation',
        workspace: 'Northwind',
        role: 'Owner',
        acceptUrl: url,
        email: 'nora@example.com',
        inviter: null,
        days: 7,
      },
      { kind: 'verification', url },
      { kind: 'password-reset', url },
      {
        kind: 'payment-failed',
        workspace: 'Northwind',
        amount: '$49.00',
        graceEndsAt: 'October 10, 2026',
        payUrl: url,
        manageUrl: 'https://studio.example/settings/billing',
      },
      {
        kind: 'receipt',
        workspace: 'Northwind',
        amount: '$49.00',
        number: 'HV-1',
        paidAt: 'October 3, 2026',
        plan: 'Pro',
        invoiceUrl: url,
        manageUrl: 'https://studio.example/settings/billing',
      },
    ] as const;
    for (const template of templates) {
      const email = await renderEmail(template);
      expect(email.subject.length, template.kind).toBeGreaterThan(5);
      expect(email.html, template.kind).toMatch(/^<!DOCTYPE html/i);
      expect(email.html, template.kind).toContain('lang="en"');
      expect(email.html, template.kind).toContain(url.replace(/&/g, '&amp;'));
      // The link stands on its own line, so clients (and tests) can take it as it is.
      expect(email.text.split('\n'), template.kind).toContain(url);
      expect(email.text, template.kind).not.toContain('<');
    }
  });

  it('keeps the wording people (and filters) know for verification and invitations', async () => {
    const verify = await renderEmail({
      kind: 'verification',
      url: 'https://api.example/verify?t=1',
    });
    expect(verify.subject).toBe('Confirm your email for Hamnivo');
    expect(verify.text.match(/https?:\/\/\S+/)?.[0]).toBe('https://api.example/verify?t=1');
    const invite = await renderEmail({
      kind: 'invitation',
      workspace: null,
      role: 'Support agent',
      acceptUrl: 'https://studio.example/invitations/accept?token=a.b',
      email: 'fay@example.com',
      inviter: 'Amal Admin',
      days: 7,
    });
    expect(invite.subject).toBe('You have been invited to Hamnivo');
    expect(invite.text).toContain(
      'Amal Admin invited you to join a Hamnivo workspace as Support agent.',
    );
    const failed = await renderEmail({
      kind: 'payment-failed',
      workspace: 'Northwind',
      amount: '$49.00',
      graceEndsAt: null,
      payUrl: null,
      manageUrl: 'https://studio.example/settings/billing',
    });
    expect(failed.text).toContain(
      'Update your payment method:\nhttps://studio.example/settings/billing',
    );
  });

  it('puts a workspace’s own name in the From header, never its address', () => {
    expect(addressOf('Hamnivo <no-reply@hamnivo.local>')).toBe('no-reply@hamnivo.local');
    expect(addressOf('no-reply@hamnivo.local')).toBe('no-reply@hamnivo.local');
    expect(displayName('Acme "Support"\r\nBcc: x <y>')).toBe('Acme Support Bcc: x y');
    expect(displayName('x'.repeat(200))).toHaveLength(80);
  });

  it('writes amounts in the currency’s own minor units', () => {
    expect(formatMinor('4900', 'USD')).toBe('$49.00');
    expect(formatMinor('500', 'JPY')).toBe('¥500');
    expect(formatMinor('12345', 'KWD')).toContain('12.345');
  });
});

describe('operator API keys', () => {
  it('generates keys only an HMAC of which is stored, verifiable across key versions', () => {
    const generated = generateOperatorKey();
    expect(generated.key).toMatch(/^hvop_[0-9a-z]{12}_[0-9A-Za-z]{43}$/);
    expect(parseOperatorKey(generated.key)).toEqual({
      prefix: generated.prefix,
      secret: generated.secret,
    });
    expect(parseOperatorKey('hv_live_x_y')).toBeNull();
    expect(bearerOperatorKey(`Bearer ${generated.key}`)).toBe(generated.key);
    expect(bearerOperatorKey('Bearer hv_live_abc')).toBeNull();
    const old = { version: 1, key: Buffer.alloc(32, 1), retired: new Map<number, Buffer>() };
    const hash = new OperatorKeyHasher(old).hash(generated.secret);
    const rotated = new OperatorKeyHasher({
      version: 2,
      key: Buffer.alloc(32, 2),
      retired: new Map([[1, Buffer.alloc(32, 1)]]),
    });
    expect(rotated.verify(generated.secret, hash, 1)).toBe(true);
    expect(rotated.verify(`${generated.secret}x`, hash, 1)).toBe(false);
    expect(rotated.verify(generated.secret, hash, 3)).toBe(false);
  });
});

describe('workspaces from billing systems', () => {
  it('derives a handle from the name and knows WHMCS references', () => {
    expect(slugFrom('Acme Support Ltd.')).toBe('acme-support-ltd');
    expect(slugFrom('Ünïcödé Café')).toBe('unicode-cafe');
    expect(slugFrom('A')).toBe('a-ws');
    expect(slugFrom('!!!')).toBe('workspace');
    expect(slugFrom('x'.repeat(60), 'ab12cd')).toHaveLength(40);
    expect(slugFrom('Acme', 'ab12cd')).toBe('acme-ab12cd');
    expect(externalProvider('whmcs:42')).toBe('whmcs');
    expect(externalProvider('blesta:42')).toBe('manual');
  });
});

describe('suspended workspaces', () => {
  const principal = (): StaffPrincipal => ({
    kind: 'staff',
    tenantId: 't',
    staffMemberId: 's',
    status: 'active',
    mfa: false,
    authenticatedAt: now,
    grants: [],
  });

  it('keep reads and billing, and refuse every other write', () => {
    const [grant] = readOnlyGrants([
      { id: 'g', permissions: ['*'], scope: { type: 'tenant' }, expiresAt: null, revokedAt: null },
    ]);
    expect(grant?.permissions).toContain('conversations.read');
    expect(grant?.permissions).toContain('billing.manage');
    expect(grant?.permissions).not.toContain('conversations.reply');
    const suspended = markSuspended(principal());
    expect(() =>
      assertWritable(suspended, { method: 'GET', url: '/v1/admin/members' }),
    ).not.toThrow();
    expect(() =>
      assertWritable(suspended, { method: 'POST', url: '/v1/admin/billing/checkout' }),
    ).not.toThrow();
    expect(() => assertWritable(suspended, { method: 'POST', url: '/v1/admin/brands' })).toThrow(
      /suspended/,
    );
    expect(() =>
      assertWritable(principal(), { method: 'POST', url: '/v1/admin/brands' }),
    ).not.toThrow();
  });

  it('show their widget as offline, and a closed one as not available', () => {
    expect(() => assertWidgetOnline('active')).not.toThrow();
    expect(() => assertWidgetOnline('suspended')).toThrow(/offline/);
    expect(() => assertWidgetOnline('closing')).toThrow(/not available/);
  });
});
