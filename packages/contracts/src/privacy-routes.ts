import {
  RetentionPolicy,
  RetentionPreview,
  RetentionPreviewQuery,
  SetRetentionRequest,
} from './privacy.js';
import type { RouteDef } from './routes.js';

/** How long the workspace keeps conversations (A10). */
export const privacyRoutes = {
  getRetentionPolicy: {
    method: 'get',
    path: '/v1/admin/privacy/retention',
    operationId: 'getRetentionPolicy',
    summary:
      'How long the workspace keeps resolved conversations, a change waiting to take effect, and what was deleted so far (privacy.manage)',
    tags: ['Administration'],
    auth: 'staff_session',
    success: { status: 200, description: 'Retention', schema: RetentionPolicy },
  },
  setRetentionPolicy: {
    method: 'put',
    path: '/v1/admin/privacy/retention',
    operationId: 'setRetentionPolicy',
    summary:
      'Keep resolved conversations for a period, or forever. Turning retention on or shortening it takes effect after the grace period; saving the period in force again undoes it (privacy.manage; recent sign-in and two-step verification)',
    tags: ['Administration'],
    auth: 'staff_session',
    body: SetRetentionRequest,
    success: { status: 200, description: 'Retention', schema: RetentionPolicy },
  },
  previewRetention: {
    method: 'get',
    path: '/v1/admin/privacy/retention/preview',
    operationId: 'previewRetention',
    summary: 'How many resolved conversations a period would delete today (privacy.manage)',
    tags: ['Administration'],
    auth: 'staff_session',
    query: RetentionPreviewQuery,
    success: { status: 200, description: 'What would be deleted', schema: RetentionPreview },
  },
} as const satisfies Record<string, RouteDef>;
