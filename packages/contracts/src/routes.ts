import { z } from 'zod';
import { adminRoutes, identityRoutes } from './admin-routes.js';
import { agentRoutes } from './agent-routes.js';
import { analyticsRoutes, billingRoutes } from './billing-routes.js';
import { cacheRoutes } from './cache-routes.js';
import { checkRoutes } from './check-routes.js';
import {
  commerceAdminRoutes,
  commerceIntegrationRoutes,
  commerceWidgetRoutes,
} from './commerce-routes.js';
import {
  CustomerConversation,
  FeedbackRequest,
  HandoffRequest,
  HandoffResponse,
  MessagePage,
  ReadReceiptRequest,
  SendMessageRequest,
  SendMessageResponse,
  StartConversationRequest,
} from './conversations.js';
import {
  customerSurfaceAdminRoutes,
  customerSurfaceWidgetRoutes,
  notificationRoutes,
} from './customer-surface-routes.js';
import { decisionRoutes } from './decision-routes.js';
import { apiKeyRoutes, networkRoutes, webhookRoutes } from './developer-routes.js';
import { HamnivoEvent, StreamControl } from './events.js';
import { inboxAlertRoutes } from './inbox-alert-routes.js';
import { inboxLibraryRoutes } from './inbox-library-routes.js';
import { inboxRoutes } from './inbox-routes.js';
import { knowledgeRoutes } from './knowledge-routes.js';
import { languageRoutes } from './language-routes.js';
import { adminMemoryRoutes, widgetMemoryRoutes } from './memory-routes.js';
import { migrationRoutes } from './migration-routes.js';
import { AttachmentPart } from './parts.js';
import { platformRoutes } from './platform-routes.js';
import { securityRoutes } from './security-routes.js';
import {
  StaffConversation,
  StaffMessageRequest,
  StaffMessageResponse,
  TakeoverRequest,
} from './staff-conversations.js';
import { actionInboxRoutes, actionWidgetRoutes, toolAdminRoutes } from './tool-routes.js';
import { visitorStaffRoutes, visitorWidgetRoutes } from './visitor-routes.js';
import {
  CreateWidgetSessionRequest,
  IdentifyRequest,
  RefreshWidgetSessionRequest,
  WidgetFramePolicy,
  WidgetSession,
} from './widget.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Who may call a route. Authorization of the specific resource still happens server-side. */
export type RouteAuth =
  | 'public'
  | 'widget_session'
  | 'staff_session'
  | 'api_key'
  /** A staff session (with X-Hamnivo-Tenant) or an API key (its own tenant). */
  | 'staff_or_api_key'
  | 'integration_signature'
  | 'provider_signature';

export interface RouteDef {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  auth: RouteAuth;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** A request body that is not JSON, such as the bytes of an uploaded file. */
  rawBody?: { contentType: string; description: string };
  /** Success response. `schema` undefined means an empty body. */
  success: { status: number; description: string; schema?: z.ZodType; contentType?: string };
  /** Accepts an Idempotency-Key header bound to the request hash. */
  idempotent?: boolean;
}

const conversationParams = z.object({
  conversationId: z.string().meta({ description: 'Conversation ID (conv_…)' }),
});

/** Customer-facing widget API (blueprint §9 "Widget/customer API"). */
export const widgetRoutes = {
  createSession: {
    method: 'post',
    path: '/v1/widget/sessions',
    operationId: 'createWidgetSession',
    summary: 'Start or resume a widget session for this browser',
    tags: ['Widget'],
    auth: 'public',
    body: CreateWidgetSessionRequest,
    success: { status: 201, description: 'Session created', schema: WidgetSession },
  },
  framePolicy: {
    method: 'get',
    path: '/v1/widget/frame-policy',
    operationId: 'getWidgetFramePolicy',
    summary: 'Websites allowed to embed this widget (used by the proxy for CSP frame-ancestors)',
    tags: ['Widget'],
    auth: 'public',
    query: z.object({ widgetId: z.string().meta({ description: 'Widget ID (wid_…)' }) }),
    success: {
      status: 200,
      description:
        'The allowed frame ancestors, also sent space-separated in the X-Hamnivo-Frame-Ancestors header',
      schema: WidgetFramePolicy,
    },
  },
  refreshSession: {
    method: 'post',
    path: '/v1/widget/sessions/refresh',
    operationId: 'refreshWidgetSession',
    summary: 'Rotate the refresh token and issue a new access token',
    tags: ['Widget'],
    auth: 'public',
    body: RefreshWidgetSessionRequest,
    success: { status: 200, description: 'Session refreshed', schema: WidgetSession },
  },
  identify: {
    method: 'post',
    path: '/v1/widget/identity',
    operationId: 'identifyWidgetSession',
    summary: 'Exchange a tenant-signed identity assertion for a verified customer session',
    tags: ['Widget'],
    auth: 'widget_session',
    body: IdentifyRequest,
    success: { status: 200, description: 'Verified session', schema: WidgetSession },
  },
  reset: {
    method: 'post',
    path: '/v1/widget/sessions/reset',
    operationId: 'resetWidgetSession',
    summary: 'End this session and remove the identity from this browser (logout)',
    tags: ['Widget'],
    auth: 'widget_session',
    success: { status: 204, description: 'Session ended' },
  },
  listConversations: {
    method: 'get',
    path: '/v1/widget/conversations',
    operationId: 'listMyConversations',
    summary: "List the signed-in customer's own conversations",
    tags: ['Widget'],
    auth: 'widget_session',
    success: {
      status: 200,
      description: 'Conversations',
      schema: z.object({ items: z.array(CustomerConversation) }),
    },
  },
  startConversation: {
    method: 'post',
    path: '/v1/widget/conversations',
    operationId: 'startConversation',
    summary: 'Start a new conversation',
    tags: ['Widget'],
    auth: 'widget_session',
    body: StartConversationRequest,
    success: { status: 201, description: 'Conversation started', schema: CustomerConversation },
    idempotent: true,
  },
  getConversation: {
    method: 'get',
    path: '/v1/widget/conversations/{conversationId}',
    operationId: 'getConversation',
    summary: 'Get one of my conversations',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    success: { status: 200, description: 'Conversation', schema: CustomerConversation },
  },
  listMessages: {
    method: 'get',
    path: '/v1/widget/conversations/{conversationId}/messages',
    operationId: 'listMessages',
    summary: 'Page through customer-visible messages, newest first',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    query: z.object({
      before: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
    success: { status: 200, description: 'Messages', schema: MessagePage },
  },
  sendMessage: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/messages',
    operationId: 'sendMessage',
    summary: 'Send a message; retries with the same clientMessageId are deduplicated',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    body: SendMessageRequest,
    success: {
      status: 202,
      description: 'Accepted after the conversation authority committed it',
      schema: SendMessageResponse,
    },
  },
  markRead: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/read',
    operationId: 'markRead',
    summary: 'Report that messages up to a sequence were displayed to the customer',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    body: ReadReceiptRequest,
    success: { status: 204, description: 'Recorded' },
  },
  requestHandoff: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/handoff',
    operationId: 'requestHandoff',
    summary: 'Ask for a person. Always honoured; availability is reported honestly',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    body: HandoffRequest,
    success: { status: 200, description: 'Handoff created', schema: HandoffResponse },
  },
  reopen: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/reopen',
    operationId: 'reopenConversation',
    summary: 'Reopen a resolved conversation, keeping its history',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    success: { status: 200, description: 'Reopened', schema: CustomerConversation },
  },
  feedback: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/feedback',
    operationId: 'submitFeedback',
    summary: 'Rate a resolved conversation',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    body: FeedbackRequest,
    success: { status: 204, description: 'Feedback stored' },
  },
  uploadAttachment: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/uploads',
    operationId: 'uploadAttachment',
    summary:
      'Upload a file into quarantine: its type is read from its bytes, it is scanned, and only a clean file can be sent',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    query: z.object({
      name: z
        .string()
        .min(1)
        .max(255)
        .meta({ description: 'The file name as the customer chose it' }),
    }),
    rawBody: {
      contentType: 'application/octet-stream',
      description: 'The file’s bytes (at most the brand’s size limit, 10 MB at most)',
    },
    success: {
      status: 201,
      description: 'Scanned and ready to send (a refused file is a 413 or 422 problem instead)',
      schema: AttachmentPart,
    },
  },
  events: {
    method: 'get',
    path: '/v1/widget/conversations/{conversationId}/events',
    operationId: 'streamEvents',
    summary: 'Server-Sent Events stream; resume with Last-Event-ID (the last seen sequence)',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    query: z.object({ after: z.coerce.number().int().min(0).optional() }),
    success: {
      status: 200,
      description:
        'Event stream (text/event-stream); data is a HamnivoEvent or a stream control frame',
      schema: z.union([HamnivoEvent, StreamControl]),
      contentType: 'text/event-stream',
    },
  },
  pollEvents: {
    method: 'get',
    path: '/v1/widget/conversations/{conversationId}/events/poll',
    operationId: 'pollEvents',
    summary: 'Long-poll fallback where streaming is blocked',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams,
    query: z.object({
      after: z.coerce.number().int().min(0),
      waitSeconds: z.coerce.number().int().min(0).max(25).default(20),
    }),
    success: {
      status: 200,
      description: 'Events after the cursor',
      schema: z.object({ events: z.array(HamnivoEvent), control: StreamControl.nullable() }),
    },
  },
} as const satisfies Record<string, RouteDef>;

/** Inbound events from the conversation authority, authenticated by their HMAC signature. */
export const integrationRoutes = {
  chatwootWebhook: {
    method: 'post',
    path: '/v1/integrations/chatwoot/{connectionId}/{source}',
    operationId: 'receiveChatwootWebhook',
    summary:
      'Chatwoot account, API-inbox or agent-bot webhook; verified, deduplicated and acknowledged before processing',
    tags: ['Integrations'],
    auth: 'integration_signature',
    params: z.object({
      connectionId: z.string().meta({ description: 'Authority connection ID (acn_…)' }),
      source: z.enum(['account', 'inbox', 'bot']),
    }),
    success: { status: 204, description: 'Accepted (or already received)' },
  },
} as const satisfies Record<string, RouteDef>;

const staffConversationParams = z.object({
  conversationId: z.string().meta({ description: 'Conversation ID (conv_…)' }),
});

/** Staff actions on a conversation (Studio, Copilot and the API; requires X-Hamnivo-Tenant). */
export const conversationRoutes = {
  getStaffConversation: {
    method: 'get',
    path: '/v1/conversations/{conversationId}',
    operationId: 'getStaffConversation',
    summary: 'Control state of a conversation (conversations.read)',
    tags: ['Conversations'],
    auth: 'staff_session',
    params: staffConversationParams,
    success: { status: 200, description: 'Conversation', schema: StaffConversation },
  },
  takeOver: {
    method: 'post',
    path: '/v1/conversations/{conversationId}/takeover',
    operationId: 'takeOverConversation',
    summary:
      'Take over from the AI or a colleague; pending AI replies are discarded (conversations.takeover)',
    tags: ['Conversations'],
    auth: 'staff_session',
    params: staffConversationParams,
    body: TakeoverRequest,
    success: { status: 200, description: 'You own the conversation', schema: StaffConversation },
  },
  returnToAi: {
    method: 'post',
    path: '/v1/conversations/{conversationId}/return-to-ai',
    operationId: 'returnConversationToAi',
    summary: 'Hand the conversation back to the AI assistant (conversations.assign)',
    tags: ['Conversations'],
    auth: 'staff_session',
    params: staffConversationParams,
    body: TakeoverRequest,
    success: { status: 200, description: 'The AI answers again', schema: StaffConversation },
  },
  sendStaffMessage: {
    method: 'post',
    path: '/v1/conversations/{conversationId}/messages',
    operationId: 'sendStaffMessage',
    summary:
      'Reply to the customer or write an internal note as yourself (conversations.reply / conversations.note)',
    tags: ['Conversations'],
    auth: 'staff_session',
    params: staffConversationParams,
    body: StaffMessageRequest,
    success: {
      status: 202,
      description: 'Committed by the authority',
      schema: StaffMessageResponse,
    },
  },
} as const satisfies Record<string, RouteDef>;

export const allRoutes: Record<string, RouteDef> = {
  ...widgetRoutes,
  ...identityRoutes,
  ...adminRoutes,
  ...agentRoutes,
  ...knowledgeRoutes,
  ...migrationRoutes,
  ...widgetMemoryRoutes,
  ...adminMemoryRoutes,
  ...integrationRoutes,
  ...conversationRoutes,
  ...decisionRoutes,
  ...checkRoutes,
  ...cacheRoutes,
  ...languageRoutes,
  ...inboxRoutes,
  ...inboxAlertRoutes,
  ...inboxLibraryRoutes,
  ...visitorWidgetRoutes,
  ...visitorStaffRoutes,
  ...securityRoutes,
  ...platformRoutes,
  ...commerceAdminRoutes,
  ...commerceWidgetRoutes,
  ...commerceIntegrationRoutes,
  ...apiKeyRoutes,
  ...webhookRoutes,
  ...networkRoutes,
  ...billingRoutes,
  ...analyticsRoutes,
  ...customerSurfaceWidgetRoutes,
  ...notificationRoutes,
  ...customerSurfaceAdminRoutes,
  ...toolAdminRoutes,
  ...actionInboxRoutes,
  ...actionWidgetRoutes,
};
