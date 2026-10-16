import type * as C from '@hamnivo/contracts';
import type { z } from 'zod';
import { api } from './api';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';

export type RetentionPolicy = z.infer<typeof C.RetentionPolicy>;
export type RetentionPreview = z.infer<typeof C.RetentionPreview>;

/** The select's value for keeping everything (the other values are days). */
export const KEEP_FOREVER = 'forever';

export const privacyKeys = {
  retention: ['privacy', 'retention'],
  preview: (days: number) => ['privacy', 'retention', 'preview', days],
} as const;

/** How long the workspace keeps resolved conversations (A10); owners only. */
export function useRetention() {
  const { can } = useTenant();
  return useStudioQuery<RetentionPolicy>(privacyKeys.retention, '/v1/admin/privacy/retention', {
    enabled: can('privacy.manage'),
    // While old conversations are being deleted, the counts move.
    refetchInterval: (data) => (data?.sweep.state === 'running' ? 30_000 : false),
  });
}

/** What a period would delete today; nothing is asked for while keeping everything. */
export function useRetentionPreview(days: number | null) {
  const { can } = useTenant();
  return useStudioQuery<RetentionPreview>(
    privacyKeys.preview(days ?? 0),
    `/v1/admin/privacy/retention/preview?days=${days ?? 0}`,
    { enabled: can('privacy.manage') && days !== null },
  );
}

export function useSetRetention() {
  return useStudioMutation(
    (body: { conversationDays: number | null; version: number }, tenant) =>
      api<RetentionPolicy>('/v1/admin/privacy/retention', { method: 'PUT', tenant, body }),
    [privacyKeys.retention],
  );
}

/** The select's value for a policy, and the days for a select value. */
export const choiceOf = (days: number | null) => (days === null ? KEEP_FOREVER : String(days));
export const daysOf = (choice: string) => (choice === KEEP_FOREVER ? null : Number(choice));

/** Whether saving `next` deletes something sooner than what is kept now (it then waits a week). */
export function deletesSooner(current: number | null, next: number | null): boolean {
  return next !== null && (current === null || next < current);
}
