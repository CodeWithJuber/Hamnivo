import { z } from 'zod';
import { TenantSlug, TenantStatus } from './admin.js';
import { PlanLimits, UsageMeter } from './billing.js';
import { LanguageTag, MinorUnits, Timestamp } from './common.js';
import { typeId } from './ids.js';
import type { RouteDef } from './routes.js';

/**
 * Running one Hamnivo install as a service for many businesses: the sign-up switch and Cloudflare
 * Turnstile, subscriptions through a billing provider (Stripe or WHMCS), plan changes and
 * suspension from the platform console, the operator API that billing systems call, automatic
 * Chatwoot set-up and the sender name of a workspace's emails.
 */

// ── Sign-up ───────────────────────────────────────────────────────────────────────────────────

export const SignupSettings = z
  .object({
    /** Anyone may create an account and a workspace. When false, only invited people may. */
    open: z.boolean(),
    /** Cloudflare Turnstile site key; null when the check is off. */
    turnstileSiteKey: z.string().nullable(),
  })
  .meta({ id: 'SignupSettings' });
export type SignupSettings = z.infer<typeof SignupSettings>;

// ── Plan and billing (Studio) ─────────────────────────────────────────────────────────────────

export const BillingProviderKind = z.enum(['free', 'stripe', 'whmcs', 'manual']);
export const SubscriptionStatus = z.enum([
  'none',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'paused',
]);

export const PlanOption = z
  .object({
    key: z.string(),
    name: z.string(),
    currency: z.string(),
    priceMinor: MinorUnits,
    limits: PlanLimits,
    trialDays: z.int().nonnegative(),
    /** Can be bought from Studio (the server's billing provider sells it). */
    purchasable: z.boolean(),
    current: z.boolean(),
  })
  .meta({ id: 'PlanOption' });

export const BillingSubscription = z
  .object({
    /** Who bills this workspace. */
    provider: BillingProviderKind,
    status: SubscriptionStatus,
    plan: z.object({ key: z.string(), name: z.string() }).nullable(),
    /** The plan is a trial until then, and falls back to the free plan afterwards. */
    trialEndsAt: Timestamp.nullable(),
    /** A payment failed: the plan stays until then, then the workspace falls back to free. */
    graceEndsAt: Timestamp.nullable(),
    paymentFailedAt: Timestamp.nullable(),
    currentPeriodEnd: Timestamp.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    /** Upgrade opens the provider's checkout. */
    canUpgrade: z.boolean(),
    /** Manage opens the provider's billing portal or client area. */
    canManage: z.boolean(),
    plans: z.array(PlanOption),
  })
  .meta({ id: 'BillingSubscription' });
export type BillingSubscription = z.infer<typeof BillingSubscription>;

export const StartCheckoutRequest = z
  .object({ planKey: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/) })
  .meta({ id: 'StartCheckoutRequest' });

/** A page of the billing provider to send the person to (checkout, portal or client area). */
export const BillingRedirect = z.object({ url: z.url() }).meta({ id: 'BillingRedirect' });

export const ProviderInvoice = z
  .object({
    id: z.string(),
    number: z.string().nullable(),
    status: z.enum(['draft', 'open', 'paid', 'void', 'uncollectible']),
    currency: z.string(),
    totalMinor: MinorUnits,
    createdAt: Timestamp,
    paidAt: Timestamp.nullable(),
    /** The provider's page for the invoice (pay or download). */
    url: z.string().nullable(),
    pdfUrl: z.string().nullable(),
  })
  .meta({ id: 'ProviderInvoice' });

export const EmailSenderSettings = z
  .object({
    /** The display name of emails this workspace sends; null: the workspace name. */
    senderName: z.string().nullable(),
    /** What is used when no name is set. */
    defaultName: z.string(),
  })
  .meta({ id: 'EmailSenderSettings' });

export const SetEmailSenderRequest = z
  .object({ senderName: z.string().trim().min(1).max(80).nullable() })
  .meta({ id: 'SetEmailSenderRequest' });

// ── Automatic Chatwoot set-up ─────────────────────────────────────────────────────────────────

export const ProvisioningStatus = z
  .object({
    brandId: typeId('brand'),
    state: z.enum(['queued', 'running', 'connected', 'failed', 'not_configured']),
    /** The last step completed (`account`, `integration_user`, `inbox`, `bot`, `webhook`, `done`). */
    step: z.string().nullable(),
    attempts: z.int().nonnegative(),
    /** A safe summary of the last failure. */
    lastError: z.string().nullable(),
    updatedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
  })
  .meta({ id: 'ProvisioningStatus' });

// ── Platform console ──────────────────────────────────────────────────────────────────────────

export const PlatformSignup = z
  .object({
    /** Whether public sign-up is on now. */
    open: z.boolean(),
    /** The server's setting (HAMNIVO_PUBLIC_SIGNUP), used when the console has not changed it. */
    envDefault: z.boolean(),
    overridden: z.boolean(),
    updatedAt: Timestamp.nullable(),
    turnstile: z.boolean(),
    /** New workspaces start on this plan; `unlimited` when they get none. */
    defaultPlan: z.string(),
  })
  .meta({ id: 'PlatformSignup' });

export const SetPlatformSignupRequest = z
  .object({
    /** null: follow the server's setting again. */
    open: z.boolean().nullable(),
  })
  .meta({ id: 'SetPlatformSignupRequest' });

export const PlatformPlan = z
  .object({
    key: z.string(),
    name: z.string(),
    currency: z.string(),
    priceMinor: MinorUnits,
    limits: PlanLimits,
    trialDays: z.int().nonnegative(),
    stripePriceId: z.string().nullable(),
  })
  .meta({ id: 'PlatformPlan' });

export const PlatformTenantBilling = z
  .object({
    tenantId: typeId('tenant'),
    status: TenantStatus,
    plan: z.object({ key: z.string(), name: z.string() }).nullable(),
    trialEndsAt: Timestamp.nullable(),
    provider: BillingProviderKind,
    subscriptionStatus: SubscriptionStatus,
    graceEndsAt: Timestamp.nullable(),
    period: z.object({ key: z.string(), start: Timestamp, end: Timestamp }),
    meters: z.array(UsageMeter),
  })
  .meta({ id: 'PlatformTenantBilling' });

export const AssignPlanRequest = z
  .object({
    planKey: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    /** Start the plan's trial (it falls back to the free plan when it ends). */
    startTrial: z.boolean().default(false),
  })
  .meta({ id: 'AssignPlanRequest' });

export const TenantStateRequest = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .meta({ id: 'TenantStateRequest' });

export const OperatorApiKey = z
  .object({
    id: typeId('operatorKey'),
    name: z.string(),
    prefix: z.string(),
    createdAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
  })
  .meta({ id: 'OperatorApiKey' });

export const CreateOperatorApiKeyRequest = z
  .object({ name: z.string().trim().min(1).max(80) })
  .meta({ id: 'CreateOperatorApiKeyRequest' });

export const CreatedOperatorApiKey = OperatorApiKey.extend({
  /** The whole key, shown once. */
  key: z.string(),
}).meta({ id: 'CreatedOperatorApiKey' });

// ── Operator API (billing systems such as WHMCS) ──────────────────────────────────────────────

/** `whmcs:<service id>` or another system's own reference; unique per workspace. */
export const ExternalRef = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,19}:[A-Za-z0-9._-]{1,64}$/, 'Expected system:reference, e.g. whmcs:42')
  .meta({ example: 'whmcs:42' });

export const OperatorCreateAccountRequest = z
  .object({
    externalRef: ExternalRef,
    name: z.string().trim().min(1).max(120),
    /** Derived from the name when left out. */
    slug: TenantSlug.optional(),
    defaultLocale: LanguageTag.default('en'),
    owner: z.object({
      email: z.email().max(254),
      name: z.string().trim().min(1).max(120),
    }),
    /** Left out: the server's default plan. */
    planKey: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,39}$/)
      .optional(),
    startTrial: z.boolean().default(false),
    /** A first brand, set up in Chatwoot right away. */
    brand: z
      .object({
        name: z.string().trim().min(1).max(120),
        website: z.url().optional(),
      })
      .optional(),
  })
  .meta({ id: 'OperatorCreateAccountRequest' });

export const OperatorAccount = z
  .object({
    tenantId: typeId('tenant'),
    externalRef: z.string().nullable(),
    name: z.string(),
    slug: z.string(),
    status: TenantStatus,
    plan: z.object({ key: z.string(), name: z.string() }).nullable(),
    trialEndsAt: Timestamp.nullable(),
    /** Studio, where the owner signs in. */
    studioUrl: z.url(),
    meters: z.array(UsageMeter),
  })
  .meta({ id: 'OperatorAccount' });

export const OperatorChangePlanRequest = z
  .object({
    planKey: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    startTrial: z.boolean().default(false),
  })
  .meta({ id: 'OperatorChangePlanRequest' });

export const OperatorReasonRequest = z
  .object({ reason: z.string().trim().min(1).max(500).default('Requested by the billing system') })
  .meta({ id: 'OperatorReasonRequest' });

// ── Routes ────────────────────────────────────────────────────────────────────────────────────

const tenantParam = z.object({
  id: z.string().meta({ description: 'Tenant ID (tnt_…)' }),
});
const accountParam = z.object({
  ref: z.string().meta({ description: 'External reference (whmcs:42), tenant ID or handle' }),
});

export const saasRoutes = {
  getSignupSettings: {
    method: 'get',
    path: '/v1/signup',
    operationId: 'getSignupSettings',
    summary: 'Whether public sign-up is open and the Turnstile site key, for the sign-up page',
    tags: ['Identity'],
    auth: 'public',
    success: { status: 200, description: 'Sign-up settings', schema: SignupSettings },
  },
  getBillingSubscription: {
    method: 'get',
    path: '/v1/admin/billing/subscription',
    operationId: 'getBillingSubscription',
    summary: 'Subscription, trial and grace period, and the plans on offer (billing.read)',
    tags: ['Billing'],
    auth: 'staff_session',
    success: { status: 200, description: 'Subscription', schema: BillingSubscription },
  },
  startCheckout: {
    method: 'post',
    path: '/v1/admin/billing/checkout',
    operationId: 'startCheckout',
    summary: 'Open the billing provider’s checkout for a plan (billing.manage)',
    tags: ['Billing'],
    auth: 'staff_session',
    body: StartCheckoutRequest,
    success: { status: 200, description: 'Checkout page', schema: BillingRedirect },
  },
  openBillingPortal: {
    method: 'post',
    path: '/v1/admin/billing/portal',
    operationId: 'openBillingPortal',
    summary: 'Open the billing provider’s portal or client area (billing.manage)',
    tags: ['Billing'],
    auth: 'staff_session',
    success: { status: 200, description: 'Portal page', schema: BillingRedirect },
  },
  listProviderInvoices: {
    method: 'get',
    path: '/v1/admin/billing/provider-invoices',
    operationId: 'listProviderInvoices',
    summary: 'Invoices from the billing provider, newest first (billing.read)',
    tags: ['Billing'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Invoices',
      schema: z.object({ items: z.array(ProviderInvoice) }),
    },
  },
  getEmailSender: {
    method: 'get',
    path: '/v1/admin/email-sender',
    operationId: 'getEmailSender',
    summary: 'The display name of the workspace’s emails (settings.manage)',
    tags: ['Administration'],
    auth: 'staff_session',
    success: { status: 200, description: 'Sender', schema: EmailSenderSettings },
  },
  setEmailSender: {
    method: 'put',
    path: '/v1/admin/email-sender',
    operationId: 'setEmailSender',
    summary: 'Set the display name of the workspace’s emails (settings.manage)',
    tags: ['Administration'],
    auth: 'staff_session',
    body: SetEmailSenderRequest,
    success: { status: 200, description: 'Sender', schema: EmailSenderSettings },
  },
  listProvisioning: {
    method: 'get',
    path: '/v1/admin/authority/provisioning',
    operationId: 'listChatwootProvisioning',
    summary: 'Progress of the automatic Chatwoot set-up of each brand (brands.manage)',
    tags: ['Administration'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Progress',
      schema: z.object({ items: z.array(ProvisioningStatus) }),
    },
  },
  stripeBillingWebhook: {
    method: 'post',
    path: '/v1/integrations/billing/stripe',
    operationId: 'receiveStripeBillingWebhook',
    summary: 'Stripe Billing events (subscriptions and invoices), each applied once',
    tags: ['Billing'],
    auth: 'provider_signature',
    body: z.record(z.string(), z.unknown()),
    success: {
      status: 200,
      description: 'Received',
      schema: z.object({ received: z.literal(true) }),
    },
  },
  platformSignup: {
    method: 'get',
    path: '/v1/platform/signup',
    operationId: 'getPlatformSignup',
    summary: 'The sign-up switch and the default plan (platform.tenants.read)',
    tags: ['Platform'],
    auth: 'staff_session',
    success: { status: 200, description: 'Sign-up', schema: PlatformSignup },
  },
  setPlatformSignup: {
    method: 'put',
    path: '/v1/platform/signup',
    operationId: 'setPlatformSignup',
    summary: 'Turn public sign-up on or off (platform.settings.manage, fresh sign-in)',
    tags: ['Platform'],
    auth: 'staff_session',
    body: SetPlatformSignupRequest,
    success: { status: 200, description: 'Sign-up', schema: PlatformSignup },
  },
  platformPlans: {
    method: 'get',
    path: '/v1/platform/plans',
    operationId: 'listPlatformPlans',
    summary: 'Active plans (platform.tenants.read)',
    tags: ['Platform'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Plans',
      schema: z.object({ items: z.array(PlatformPlan) }),
    },
  },
  platformTenantBilling: {
    method: 'get',
    path: '/v1/platform/tenants/{id}/billing',
    operationId: 'getPlatformTenantBilling',
    summary: 'A tenant’s plan, trial, subscription and usage this period (platform.tenants.read)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: tenantParam,
    success: { status: 200, description: 'Billing', schema: PlatformTenantBilling },
  },
  assignTenantPlan: {
    method: 'put',
    path: '/v1/platform/tenants/{id}/plan',
    operationId: 'assignTenantPlan',
    summary: 'Give a tenant a plan, optionally as a trial (platform.tenants.manage, fresh sign-in)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: tenantParam,
    body: AssignPlanRequest,
    success: { status: 200, description: 'Billing', schema: PlatformTenantBilling },
  },
  suspendTenant: {
    method: 'post',
    path: '/v1/platform/tenants/{id}/suspend',
    operationId: 'suspendTenant',
    summary:
      'Suspend a tenant: its widget shows offline and its staff can only read (platform.tenants.manage)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: tenantParam,
    body: TenantStateRequest,
    success: { status: 200, description: 'Billing', schema: PlatformTenantBilling },
  },
  reactivateTenant: {
    method: 'post',
    path: '/v1/platform/tenants/{id}/reactivate',
    operationId: 'reactivateTenant',
    summary: 'Reactivate a suspended tenant (platform.tenants.manage, fresh sign-in)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: tenantParam,
    body: TenantStateRequest,
    success: { status: 200, description: 'Billing', schema: PlatformTenantBilling },
  },
  listOperatorKeys: {
    method: 'get',
    path: '/v1/platform/operator-keys',
    operationId: 'listOperatorKeys',
    summary: 'Operator API keys for billing systems (platform.settings.manage)',
    tags: ['Platform'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Keys',
      schema: z.object({ items: z.array(OperatorApiKey) }),
    },
  },
  createOperatorKey: {
    method: 'post',
    path: '/v1/platform/operator-keys',
    operationId: 'createOperatorKey',
    summary: 'Create an operator API key; the key is shown once (platform.settings.manage)',
    tags: ['Platform'],
    auth: 'staff_session',
    body: CreateOperatorApiKeyRequest,
    success: { status: 201, description: 'Created', schema: CreatedOperatorApiKey },
  },
  revokeOperatorKey: {
    method: 'post',
    path: '/v1/platform/operator-keys/{id}/revoke',
    operationId: 'revokeOperatorKey',
    summary: 'Revoke an operator API key (platform.settings.manage)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: z.object({ id: z.string().meta({ description: 'Operator key ID (opk_…)' }) }),
    success: { status: 200, description: 'Revoked', schema: OperatorApiKey },
  },
  operatorPing: {
    method: 'get',
    path: '/v1/operator/ping',
    operationId: 'operatorPing',
    summary: 'Check an operator API key (the WHMCS module’s Test Connection)',
    tags: ['Operator API'],
    auth: 'operator_key',
    success: {
      status: 200,
      description: 'The key works',
      schema: z.object({ ok: z.literal(true), plans: z.array(z.string()) }),
    },
  },
  operatorCreateAccount: {
    method: 'post',
    path: '/v1/operator/accounts',
    operationId: 'operatorCreateAccount',
    summary:
      'Create a workspace and invite its owner; repeating it with the same external reference returns the same workspace',
    tags: ['Operator API'],
    auth: 'operator_key',
    body: OperatorCreateAccountRequest,
    success: { status: 201, description: 'Workspace', schema: OperatorAccount },
  },
  operatorGetAccount: {
    method: 'get',
    path: '/v1/operator/accounts/{ref}',
    operationId: 'operatorGetAccount',
    summary: 'A workspace, its plan and its usage',
    tags: ['Operator API'],
    auth: 'operator_key',
    params: accountParam,
    success: { status: 200, description: 'Workspace', schema: OperatorAccount },
  },
  operatorSuspendAccount: {
    method: 'post',
    path: '/v1/operator/accounts/{ref}/suspend',
    operationId: 'operatorSuspendAccount',
    summary: 'Suspend a workspace (safe to repeat)',
    tags: ['Operator API'],
    auth: 'operator_key',
    params: accountParam,
    body: OperatorReasonRequest,
    success: { status: 200, description: 'Workspace', schema: OperatorAccount },
  },
  operatorUnsuspendAccount: {
    method: 'post',
    path: '/v1/operator/accounts/{ref}/unsuspend',
    operationId: 'operatorUnsuspendAccount',
    summary: 'Reactivate a suspended workspace (safe to repeat)',
    tags: ['Operator API'],
    auth: 'operator_key',
    params: accountParam,
    body: OperatorReasonRequest,
    success: { status: 200, description: 'Workspace', schema: OperatorAccount },
  },
  operatorTerminateAccount: {
    method: 'post',
    path: '/v1/operator/accounts/{ref}/terminate',
    operationId: 'operatorTerminateAccount',
    summary:
      'Close a workspace: staff and the widget lose access at once; the data is kept until the operator deletes it',
    tags: ['Operator API'],
    auth: 'operator_key',
    params: accountParam,
    body: OperatorReasonRequest,
    success: { status: 200, description: 'Workspace', schema: OperatorAccount },
  },
  operatorChangePlan: {
    method: 'put',
    path: '/v1/operator/accounts/{ref}/plan',
    operationId: 'operatorChangePlan',
    summary: 'Change a workspace’s plan (safe to repeat)',
    tags: ['Operator API'],
    auth: 'operator_key',
    params: accountParam,
    body: OperatorChangePlanRequest,
    success: { status: 200, description: 'Workspace', schema: OperatorAccount },
  },
} as const satisfies Record<string, RouteDef>;
