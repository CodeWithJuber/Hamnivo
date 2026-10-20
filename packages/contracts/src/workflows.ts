// biome-ignore-all lint/suspicious/noThenProperty: Workflow branch targets are strings, never promise callbacks.
import { z } from 'zod';
import { Timestamp } from './common.js';
import type { RouteDef } from './routes.js';

const StepId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const Next = StepId.nullable();
const Base = { id: StepId, label: z.string().trim().min(1).max(100) };
export const WorkflowValueReference = z.object({
  stepId: StepId,
  path: z
    .array(z.union([z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/), z.int().min(0).max(31)]))
    .max(6),
});
export type WorkflowValueReference = z.infer<typeof WorkflowValueReference>;
export const WorkflowPredicate = z.object({
  field: z.enum(['event', 'hours_open', 'signed_in', 'country', 'language', 'tag', 'result']),
  op: z.enum(['is', 'is_not', 'contains']),
  value: z.union([z.string().max(200), z.boolean(), z.number().finite()]),
  source: WorkflowValueReference.optional(),
});
export const WorkflowStep = z
  .discriminatedUnion('type', [
    z.object({ ...Base, type: z.literal('trigger'), next: Next }),
    z.object({
      ...Base,
      type: z.enum(['condition', 'branch']),
      predicate: WorkflowPredicate,
      then: Next,
      otherwise: Next,
    }),
    z.object({
      ...Base,
      type: z.literal('knowledge_lookup'),
      query: z.string().trim().min(1).max(1000),
      queryFrom: WorkflowValueReference.optional(),
      next: Next,
    }),
    z.object({
      ...Base,
      type: z.enum(['tool_action', 'approval']),
      toolId: z.string().min(1),
      arguments: z.record(z.string(), z.json()),
      bindings: z
        .record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/), WorkflowValueReference)
        .refine((value) => Object.keys(value).length <= 16)
        .optional(),
      next: Next,
    }),
    z.object({ ...Base, type: z.literal('wait'), seconds: z.int().min(1).max(86400), next: Next }),
    z.object({
      ...Base,
      type: z.literal('delegate'),
      connectionId: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
      request: z.string().trim().min(1).max(4000),
      requestFrom: WorkflowValueReference.optional(),
      next: Next,
    }),
    z.object({ ...Base, type: z.literal('handoff'), reason: z.string().trim().min(1).max(500) }),
  ])
  .meta({ id: 'WorkflowStep' });
export type WorkflowStep = z.infer<typeof WorkflowStep>;
export const WorkflowDefinition = z
  .object({
    agentId: z.string().min(1),
    trigger: z.object({
      type: z.enum([
        'manual',
        'chat_started',
        'customer_message',
        'chat_closed',
        'offline_message',
      ]),
    }),
    allowedDelegateAgentIds: z.array(z.string().min(1)).max(8).default([]),
    entry: StepId,
    steps: z.array(WorkflowStep).min(1).max(50),
    budget: z.object({
      maxSteps: z.int().min(1).max(100),
      maxDelegations: z.int().min(0).max(8),
      maxDurationSeconds: z.int().min(1).max(86400),
      maxDepth: z.int().min(0).max(3),
    }),
  })
  .meta({ id: 'WorkflowDefinition' });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
const Name = z.string().trim().min(1).max(80);
export const WorkflowVersion = z
  .object({
    version: z.int().positive(),
    name: Name,
    definition: WorkflowDefinition,
    publishedAt: Timestamp,
  })
  .meta({ id: 'WorkflowVersion' });
export const Workflow = z
  .object({
    id: z.string(),
    brandId: z.string(),
    name: Name,
    enabled: z.boolean(),
    revision: z.int().positive(),
    draft: WorkflowDefinition,
    published: WorkflowVersion.nullable(),
    unpublishedChanges: z.boolean(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'Workflow' });
export type Workflow = z.infer<typeof Workflow>;
export const WorkflowRunState = z.enum([
  'queued',
  'running',
  'waiting',
  'awaiting_approval',
  'completed',
  'cancelled',
  'handed_off',
  'failed',
]);
export const WorkflowStepResult = z.object({
  source: z.enum(['knowledge', 'tool', 'local_specialist', 'external_agent']),
  trust: z.literal('untrusted'),
  text: z.string().max(16000).optional(),
  summary: z.string().max(2000).optional(),
  agentId: z.string().optional(),
  agentVersionId: z.string().optional(),
  taskId: z.string().nullable().optional(),
  state: z.string().max(100).optional(),
  knowledgeRefs: z
    .array(z.object({ sourceId: z.string(), documentId: z.string(), versionId: z.string() }))
    .max(5)
    .optional(),
  passages: z
    .array(
      z.object({
        sourceId: z.string(),
        documentId: z.string(),
        versionId: z.string().optional(),
        text: z.string().max(2000),
      }),
    )
    .max(5)
    .optional(),
});
export const WorkflowRunStep = z.object({
  stepId: z.string(),
  type: z.string(),
  state: z.enum(['running', 'waiting', 'awaiting_approval', 'completed', 'failed', 'unknown']),
  actionId: z.string().nullable(),
  summary: z.string().nullable(),
  result: WorkflowStepResult.nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export const WorkflowRun = z.object({
  id: z.string(),
  workflowId: z.string(),
  version: z.int().positive(),
  conversationId: z.string(),
  state: WorkflowRunState,
  currentStepId: z.string().nullable(),
  reason: z.string().nullable(),
  wakeAt: Timestamp.nullable(),
  stepsUsed: z.int().nonnegative(),
  delegationsUsed: z.int().nonnegative(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  steps: z.array(WorkflowRunStep),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;
export const CreateWorkflowRequest = z.object({ name: Name, definition: WorkflowDefinition });
export const SaveWorkflowRequest = CreateWorkflowRequest.extend({ revision: z.int().positive() });
export const PublishWorkflowRequest = z.object({ revision: z.int().positive() });
export const StartWorkflowRequest = z.object({
  conversationId: z.string(),
  eventKey: z.string().trim().min(1).max(200),
});
export const A2AConnection = z.object({
  id: z.string(),
  brandId: z.string(),
  name: Name,
  endpoint: z.url(),
  enabled: z.boolean(),
  timeoutSeconds: z.int().min(1).max(30),
  hasCredential: z.boolean(),
  protocolVersion: z.literal('1.0'),
});
export const CreateA2AConnectionRequest = z.object({
  name: Name,
  endpoint: z.url(),
  credentialSecretId: z.string().nullable().default(null),
  timeoutSeconds: z.int().min(1).max(30).default(15),
});
export const SetWorkflowEnabledRequest = z.object({ enabled: z.boolean() });
const wp = z.object({ workflowId: z.string() });
const bp = z.object({ brandId: z.string() });
const tag = ['Workflows'];
export const workflowRoutes = {
  listWorkflows: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/workflows',
    operationId: 'listWorkflows',
    summary: 'List durable workflows',
    tags: tag,
    auth: 'staff_session',
    params: bp,
    success: {
      status: 200,
      description: 'Workflows',
      schema: z.object({ items: z.array(Workflow) }),
    },
  },
  createWorkflow: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/workflows',
    operationId: 'createWorkflow',
    summary: 'Create workflow draft',
    tags: tag,
    auth: 'staff_session',
    params: bp,
    body: CreateWorkflowRequest,
    success: { status: 201, description: 'Workflow', schema: Workflow },
  },
  getWorkflow: {
    method: 'get',
    path: '/v1/admin/workflows/{workflowId}',
    operationId: 'getWorkflow',
    summary: 'Read workflow',
    tags: tag,
    auth: 'staff_session',
    params: wp,
    success: { status: 200, description: 'Workflow', schema: Workflow },
  },
  saveWorkflow: {
    method: 'put',
    path: '/v1/admin/workflows/{workflowId}',
    operationId: 'saveWorkflow',
    summary: 'Save workflow draft',
    tags: tag,
    auth: 'staff_session',
    params: wp,
    body: SaveWorkflowRequest,
    success: { status: 200, description: 'Workflow', schema: Workflow },
  },
  publishWorkflow: {
    method: 'post',
    path: '/v1/admin/workflows/{workflowId}/publish',
    operationId: 'publishWorkflow',
    summary: 'Publish immutable version',
    tags: tag,
    auth: 'staff_session',
    params: wp,
    body: PublishWorkflowRequest,
    success: { status: 200, description: 'Workflow', schema: Workflow },
  },
  setWorkflowEnabled: {
    method: 'put',
    path: '/v1/admin/workflows/{workflowId}/enabled',
    operationId: 'setWorkflowEnabled',
    summary: 'Pause or resume workflow',
    tags: tag,
    auth: 'staff_session',
    params: wp,
    body: SetWorkflowEnabledRequest,
    success: { status: 200, description: 'Workflow', schema: Workflow },
  },
  listWorkflowVersions: {
    method: 'get',
    path: '/v1/admin/workflows/{workflowId}/versions',
    operationId: 'listWorkflowVersions',
    summary: 'List immutable workflow versions',
    tags: tag,
    auth: 'staff_session',
    params: wp,
    success: {
      status: 200,
      description: 'Versions',
      schema: z.object({ items: z.array(WorkflowVersion) }),
    },
  },
  restoreWorkflowVersion: {
    method: 'post',
    path: '/v1/admin/workflows/{workflowId}/versions/{version}/restore',
    operationId: 'restoreWorkflowVersion',
    summary: 'Restore version into draft',
    tags: tag,
    auth: 'staff_session',
    params: wp.extend({ version: z.coerce.number().int().positive() }),
    body: PublishWorkflowRequest,
    success: { status: 200, description: 'Workflow', schema: Workflow },
  },
  listWorkflowRuns: {
    method: 'get',
    path: '/v1/admin/workflows/{workflowId}/runs',
    operationId: 'listWorkflowRuns',
    summary: 'Read workflow run history',
    tags: tag,
    auth: 'staff_session',
    params: wp,
    success: {
      status: 200,
      description: 'Runs',
      schema: z.object({ items: z.array(WorkflowRun) }),
    },
  },
  startWorkflow: {
    method: 'post',
    path: '/v1/admin/workflows/{workflowId}/runs',
    operationId: 'startWorkflow',
    summary: 'Start workflow for an AI-owned conversation',
    tags: tag,
    auth: 'staff_session',
    params: wp,
    body: StartWorkflowRequest,
    success: { status: 201, description: 'Run', schema: WorkflowRun },
  },
  cancelWorkflowRun: {
    method: 'post',
    path: '/v1/admin/workflow-runs/{runId}/cancel',
    operationId: 'cancelWorkflowRun',
    summary: 'Cancel durable workflow',
    tags: tag,
    auth: 'staff_session',
    params: z.object({ runId: z.string() }),
    success: { status: 200, description: 'Run', schema: WorkflowRun },
  },
  listA2AConnections: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/a2a-connections',
    operationId: 'listA2AConnections',
    summary: 'List private specialist connections',
    tags: tag,
    auth: 'staff_session',
    params: bp,
    success: {
      status: 200,
      description: 'Connections',
      schema: z.object({ items: z.array(A2AConnection) }),
    },
  },
  createA2AConnection: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/a2a-connections',
    operationId: 'createA2AConnection',
    summary: 'Connect an A2A 1.0 HTTP specialist',
    tags: tag,
    auth: 'staff_session',
    params: bp,
    body: CreateA2AConnectionRequest,
    success: { status: 201, description: 'Connection', schema: A2AConnection },
  },
  setA2AConnectionEnabled: {
    method: 'put',
    path: '/v1/admin/a2a-connections/{connectionId}/enabled',
    operationId: 'setA2AConnectionEnabled',
    summary: 'Enable or disable specialist connection',
    tags: tag,
    auth: 'staff_session',
    params: z.object({ connectionId: z.string() }),
    body: SetWorkflowEnabledRequest,
    success: { status: 200, description: 'Connection', schema: A2AConnection },
  },
} as const satisfies Record<string, RouteDef>;
