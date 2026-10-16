import { z } from 'zod';
import { Timestamp } from './common.js';

/**
 * How long a workspace may keep resolved conversations, in days (A10): 3 and 6 months, then 1, 2,
 * 3, 5 and 7 years. The database accepts the same list.
 */
export const RETENTION_DAYS = [90, 180, 365, 730, 1095, 1825, 2555] as const;
export type RetentionDays = (typeof RETENTION_DAYS)[number];

const Days = z
  .int()
  .refine((value) => (RETENTION_DAYS as readonly number[]).includes(value), {
    message: `One of ${RETENTION_DAYS.join(', ')}`,
  })
  .meta({ description: `Days: one of ${RETENTION_DAYS.join(', ')}` });

export const RetentionPolicy = z
  .object({
    /** Days a resolved conversation is kept after its last activity; null keeps everything. */
    conversationDays: Days.nullable(),
    /** A shorter period that takes effect at `from` unless it is undone first. */
    pending: z.object({ conversationDays: Days, from: Timestamp }).nullable(),
    /** The periods to choose from, and how long turning retention on or shortening it waits. */
    choices: z.array(z.int()),
    graceDays: z.int().positive(),
    /**
     * The deletions so far. `blocked`: the chat engine refused to delete because its Hamnivo user
     * is not an administrator, so nothing was deleted in Hamnivo either.
     */
    sweep: z.object({
      state: z.enum(['idle', 'running', 'blocked']),
      sweptAt: Timestamp.nullable(),
      conversationsDeleted: z.int().nonnegative(),
      customersDeleted: z.int().nonnegative(),
    }),
    updatedAt: Timestamp.nullable(),
    /** 0 while the workspace has never saved a policy. */
    version: z.int().nonnegative(),
  })
  .meta({ id: 'RetentionPolicy' });
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

export const SetRetentionRequest = z
  .object({
    /** Null keeps everything. Turning retention on or shortening it waits `graceDays` first. */
    conversationDays: Days.nullable(),
    /** The version you read; a different current version is VERSION_CONFLICT. */
    version: z.int().nonnegative(),
  })
  .meta({ id: 'SetRetentionRequest' });
export type SetRetentionRequest = z.infer<typeof SetRetentionRequest>;

export const RetentionPreviewQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((value) => (RETENTION_DAYS as readonly number[]).includes(value))
    .meta({ description: `One of ${RETENTION_DAYS.join(', ')}` }),
});

/** What a period would delete in this workspace today. */
export const RetentionPreview = z
  .object({
    conversationDays: z.int(),
    /** Resolved conversations whose last activity is older than the period. */
    conversations: z.int().nonnegative(),
    /** The oldest of them, or null when there are none. */
    oldestActivityAt: Timestamp.nullable(),
    /** When deleting would start if the period were saved now. */
    deletesFrom: Timestamp,
  })
  .meta({ id: 'RetentionPreview' });
export type RetentionPreview = z.infer<typeof RetentionPreview>;
