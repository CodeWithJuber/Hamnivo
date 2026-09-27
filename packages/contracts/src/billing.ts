import { z } from 'zod';
import { MinorUnits, Timestamp } from './common.js';
import { typeId } from './ids.js';

/**
 * Plans, usage limits and invoices (A08, A15, A16; board 23). Hamnivo's platform operator defines
 * plans and issues invoices; a workspace sees its plan, its usage against the limits, its own
 * budget and its invoices. Plans limit how much a workspace may use; they never grant permissions.
 */

export const LimitKey = z
  .enum([
    'conversations',
    'aiReplies',
    'aiTokens',
    'knowledgeStorageBytes',
    'seats',
    'webhookEndpoints',
  ])
  .meta({ id: 'LimitKey' });
export type LimitKey = z.infer<typeof LimitKey>;

export const PlanLimits = z.record(LimitKey, z.int().nonnegative().nullable());

export const MeteredPrice = z.object({
  limit: z.enum(['conversations', 'aiReplies', 'aiTokens']),
  includedUnits: z.int().nonnegative(),
  unitPriceMinor: MinorUnits,
  perUnits: z.int().positive(),
});

export const Plan = z
  .object({
    key: z.string(),
    name: z.string(),
    currency: z.string(),
    /** Price per billing period (a calendar month, UTC). */
    priceMinor: MinorUnits,
    /** null: unlimited. */
    limits: PlanLimits,
    metered: z.array(MeteredPrice),
  })
  .meta({ id: 'Plan' });

export const UsageMeter = z
  .object({
    limit: LimitKey,
    /** `period`: counted since the period began. `capacity`: in use right now. */
    kind: z.enum(['period', 'capacity']),
    unit: z.enum(['conversation', 'reply', 'token', 'byte', 'seat', 'endpoint']),
    used: z.int().nonnegative(),
    max: z.int().nonnegative().nullable(),
    remaining: z.int().nonnegative().nullable(),
    state: z.enum(['unlimited', 'ok', 'warning', 'reached']),
  })
  .meta({ id: 'UsageMeter' });

export const UsageAlert = z.object({
  limit: z.string(),
  source: z.enum(['plan', 'budget']),
  threshold: z.int(),
  used: z.int().nonnegative(),
  max: z.int().nonnegative(),
  at: Timestamp,
});

export const AiStatus = z.object({
  /** Whether new AI replies are allowed; when not, conversations go to people instead. */
  allowed: z.boolean(),
  reason: z.enum(['plan_replies', 'plan_tokens', 'budget_tokens']).nullable(),
});

export const Budget = z
  .object({
    /** The workspace's own ceiling on AI tokens per period, below the plan's; null: none. */
    aiTokens: z.int().nonnegative().nullable(),
    /** Percentages of a limit that raise an alert. */
    alertThresholds: z.array(z.int().min(1).max(100)),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'Budget' });

export const UsageOverview = z
  .object({
    period: z.object({ key: z.string(), start: Timestamp, end: Timestamp }),
    /** When usage was measured (usage is read live from the ledger). */
    measuredAt: Timestamp,
    /** No plan assigned: nothing is limited. */
    limited: z.boolean(),
    meters: z.array(UsageMeter),
    ai: AiStatus,
    budget: Budget,
    alerts: z.array(UsageAlert),
  })
  .meta({ id: 'UsageOverview' });

export const InvoiceStatus = z.enum(['draft', 'issued', 'paid', 'void']);

export const InvoicePayment = z.object({
  /** How the invoice is being paid; `manual` means the operator records it. */
  method: z.enum(['manual', 'provider']),
  state: z.enum(['none', 'pending', 'failed', 'paid']),
  lastFailureAt: Timestamp.nullable(),
  nextRetryAt: Timestamp.nullable(),
});

export const InvoiceSummary = z
  .object({
    id: typeId('invoice'),
    number: z.string(),
    period: z.object({ key: z.string(), start: Timestamp, end: Timestamp }),
    status: InvoiceStatus,
    currency: z.string(),
    totalMinor: MinorUnits,
    issuedAt: Timestamp.nullable(),
    dueAt: Timestamp.nullable(),
    paidAt: Timestamp.nullable(),
    voidedAt: Timestamp.nullable(),
    /** Issued, unpaid and past its due date. */
    overdue: z.boolean(),
    payment: InvoicePayment,
  })
  .meta({ id: 'InvoiceSummary' });

export const InvoiceLine = z.object({
  kind: z.enum(['plan', 'metered']),
  limit: z.string().nullable(),
  description: z.string(),
  quantity: z.int().nonnegative(),
  includedUnits: z.int().nonnegative().nullable(),
  billableUnits: z.int().nonnegative(),
  perUnits: z.int().positive(),
  unitPriceMinor: MinorUnits,
  amountMinor: MinorUnits,
});

export const Invoice = InvoiceSummary.extend({
  planName: z.string(),
  lines: z.array(InvoiceLine),
  subtotalMinor: MinorUnits,
  /** Usage measured for the period, by limit. */
  usage: z.record(z.string(), z.int().nonnegative()),
}).meta({ id: 'Invoice' });

export const BillingOverview = z
  .object({
    plan: Plan.nullable(),
    /** `past_due`: an issued invoice is overdue. */
    standing: z.enum(['no_plan', 'active', 'past_due']),
    usage: UsageOverview,
    invoices: z.array(InvoiceSummary),
  })
  .meta({ id: 'BillingOverview' });

export const SetBudgetRequest = z
  .object({
    aiTokens: z.int().nonnegative().max(1_000_000_000_000).nullable(),
    alertThresholds: z.array(z.int().min(1).max(100)).max(5),
  })
  .meta({ id: 'SetBudgetRequest' });
