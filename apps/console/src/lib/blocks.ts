/**
 * Blocking visitors (H20) in Studio: the block dialog in a chat and on Live visitors, and the list
 * of blocks to unblock from. The gateway decides who may block (`visitors.block`) and which brands
 * a person sees; this file asks for it and words it. A blocked visitor is told only that chat
 * isn't available, never that they were blocked.
 */
import type * as C from '@hamnivo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from './api';
import { inboxKeys } from './inbox';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';
import { visitorKeys } from './visitors';

export type VisitorBlock = C.VisitorBlock;
export type BlockDuration = C.BlockDuration;
export type BlockListStatus = 'active' | 'all';

/** The choices of "How long", shortest first (the gateway's `BlockDuration`). */
export const BLOCK_DURATIONS = [
  'day',
  'week',
  'month',
  'always',
] as const satisfies readonly BlockDuration[];

/** The longest reason the gateway accepts. */
export const REASON_MAX = 500;

const DAY_MS = 86_400_000;
const DURATION_MS: Record<BlockDuration, number | null> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  always: null,
};

/** When a block chosen now would end (as the gateway counts it); null: until someone lifts it. */
export function expiryFor(duration: BlockDuration, now: Date = new Date()): Date | null {
  const ms = DURATION_MS[duration];
  return ms === null ? null : new Date(now.getTime() + ms);
}

/**
 * Where a block stands, for its "Expires" column: still on (until a time, or until someone lifts
 * it), lifted by a person, or run out on its own.
 */
export type BlockStanding =
  | { kind: 'never' }
  | { kind: 'until'; at: string }
  | { kind: 'lifted'; at: string; by: string | null }
  | { kind: 'expired'; at: string };

export function standingOf(block: VisitorBlock, now: number = Date.now()): BlockStanding {
  if (block.liftedAt)
    return { kind: 'lifted', at: block.liftedAt, by: block.liftedBy?.name ?? null };
  if (block.expiresAt === null) return { kind: 'never' };
  if (Date.parse(block.expiresAt) <= now) return { kind: 'expired', at: block.expiresAt };
  return { kind: 'until', at: block.expiresAt };
}

/** Whether a block still stops the visitor (the gateway's `active`, re-checked against the clock). */
export const isActive = (block: VisitorBlock, now: number = Date.now()) => {
  const standing = standingOf(block, now);
  return standing.kind === 'never' || standing.kind === 'until';
};

/** The gateway's message for one field of a refused block (e.g. `reason`), if it sent one. */
export function fieldError(error: unknown, field: string): string | undefined {
  if (!isApiError(error)) return undefined;
  return error.fields.find((f) => f.path === field || f.path.startsWith(`${field}.`))?.message;
}

// ------------------------------------------------------------------ requests

export const blockKeys = {
  all: ['visitors', 'blocks'] as const,
  list: (brandId: string, status: BlockListStatus) =>
    ['visitors', 'blocks', brandId, status] as const,
};

/** Blocks the person may see, newest first: those still on, or every one of the last 90 days. */
export function useVisitorBlocks(brandId: string, status: BlockListStatus) {
  const { can } = useTenant();
  const query = new URLSearchParams({ status });
  if (brandId) query.set('brandId', brandId);
  return useStudioQuery<C.VisitorBlockList>(
    blockKeys.list(brandId, status),
    `/v1/visitors/blocks?${query}`,
    { enabled: can('visitors.block') },
  );
}

/** Who is blocked: the customer of a chat, or a browser on Live visitors. */
export type BlockTarget =
  | { kind: 'conversation'; conversationId: string; name: string }
  | { kind: 'visitor'; visitorId: string; name: string };

export interface BlockInput {
  target: BlockTarget;
  reason: string;
  duration: BlockDuration;
  /** From a chat only: also close it. */
  closeChat: boolean;
}

/**
 * Blocks a visitor. From a chat it also closes the chat when asked; the chat, the inbox lists and
 * Live visitors reload afterwards, and so does the list of blocks.
 */
export function useBlockVisitor() {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const mutation = useStudioMutation<BlockInput, VisitorBlock>(
    ({ target, reason, duration, closeChat }, tenant) =>
      target.kind === 'conversation'
        ? api<VisitorBlock>(
            `/v1/inbox/conversations/${encodeURIComponent(target.conversationId)}/block`,
            { method: 'POST', tenant, body: { reason, duration, closeChat } },
          )
        : api<VisitorBlock>(`/v1/visitors/${encodeURIComponent(target.visitorId)}/block`, {
            method: 'POST',
            tenant,
            body: { reason, duration },
          }),
    [blockKeys.all],
  );
  return {
    ...mutation,
    /** Reloads what a block changed: the chat it came from and the lists that show it. */
    refresh: (target: BlockTarget) =>
      Promise.all([
        target.kind === 'conversation'
          ? client.invalidateQueries({
              queryKey: [tenantId, ...inboxKeys.conversation(target.conversationId)],
            })
          : undefined,
        client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.lists] }),
        client.invalidateQueries({ queryKey: [tenantId, ...visitorKeys.anyLive] }),
      ]),
  };
}

/** Unblocks at once: the visitor can chat again. */
export function useLiftBlock() {
  return useStudioMutation<string, VisitorBlock>(
    (blockId, tenant) =>
      api<VisitorBlock>(`/v1/visitors/blocks/${encodeURIComponent(blockId)}`, {
        method: 'DELETE',
        tenant,
      }),
    [blockKeys.all],
  );
}
