import { z } from 'zod';
import { CheckRecord, CheckRubric, CheckTask, SaveCheckDraftRequest } from './checks.js';
import { Cursor, page } from './common.js';
import { SetDecisionModeRequest } from './decisions.js';
import type { RouteDef } from './routes.js';

const brandParams = z.object({
  brandId: z.string().meta({ description: 'Brand ID (brd_…)' }),
});
const taskParams = brandParams.extend({
  task: z.string().meta({ description: 'Check, such as answer-check' }),
});

/** Checks around AI replies: rubrics, shadow and live modes, and records. */
export const checkRoutes = {
  listCheckTasks: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/checks',
    operationId: 'listCheckTasks',
    summary: 'Checks around AI replies, with their modes and rubrics (decisions.read)',
    tags: ['Decisions'],
    auth: 'staff_session',
    params: brandParams,
    success: {
      status: 200,
      description: 'Checks',
      schema: z.object({ items: z.array(CheckTask) }),
    },
  },
  saveCheckDraft: {
    method: 'put',
    path: '/v1/admin/brands/{brandId}/checks/{task}/draft',
    operationId: 'saveCheckDraft',
    summary: 'Save a check’s draft thresholds; drafts are never used (decisions.manage)',
    tags: ['Decisions'],
    auth: 'staff_session',
    params: taskParams,
    body: SaveCheckDraftRequest,
    success: { status: 200, description: 'Draft saved', schema: CheckRubric },
  },
  publishCheck: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/checks/{task}/publish',
    operationId: 'publishCheck',
    summary: 'Publish a check’s draft as its next immutable version (decisions.manage)',
    tags: ['Decisions'],
    auth: 'staff_session',
    params: taskParams,
    success: { status: 200, description: 'Published', schema: CheckTask },
  },
  setCheckMode: {
    method: 'put',
    path: '/v1/admin/brands/{brandId}/checks/{task}/mode',
    operationId: 'setCheckMode',
    summary: 'Turn a check off, run it in shadow or make it live (decisions.manage)',
    tags: ['Decisions'],
    auth: 'staff_session',
    params: taskParams,
    body: SetDecisionModeRequest,
    success: { status: 200, description: 'Mode set', schema: CheckTask },
  },
  listCheckRecords: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/checks/{task}/records',
    operationId: 'listCheckRecords',
    summary: 'Recorded checks, newest first (decisions.read)',
    tags: ['Decisions'],
    auth: 'staff_session',
    params: taskParams,
    query: z.object({
      conversationId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: Cursor.optional(),
    }),
    success: { status: 200, description: 'Checks', schema: page(CheckRecord) },
  },
} as const satisfies Record<string, RouteDef>;
