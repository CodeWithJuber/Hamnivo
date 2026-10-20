import { z } from 'zod';
import { Timestamp } from './common.js';

/** The credential that pays for a provider call. A tenant connection always means BYOK. */
export const AiUsageSource = z.enum(['managed', 'byok']);
export type AiUsageSource = z.infer<typeof AiUsageSource>;

export const AiCreditAttempt = z.object({
  key: z.string(),
  source: AiUsageSource,
  status: z.enum(['reserved', 'settled', 'released', 'expired']),
  provider: z.string(),
  modelId: z.string(),
  periodKey: z.string(),
  reservedTokens: z.int().nonnegative(),
  inputTokens: z.int().nonnegative().nullable(),
  outputTokens: z.int().nonnegative().nullable(),
  creditsMilli: z.int().nonnegative(),
  rateVersion: z.int().positive().nullable(),
  attribution: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
});

export const AiUsageOverview = z.object({
  payerTenantId: z.uuid(),
  period: z.object({ key: z.string(), start: Timestamp, end: Timestamp }),
  managed: z.object({
    settledTokens: z.int().nonnegative(),
    reservedTokens: z.int().nonnegative(),
    creditsMilli: z.int().nonnegative(),
  }),
  byok: z.object({ tokens: z.int().nonnegative() }),
  attempts: z.array(AiCreditAttempt),
});
