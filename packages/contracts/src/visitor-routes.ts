import { z } from 'zod';
import type { RouteDef } from './routes.js';
import {
  ConversationVisitor,
  LiveVisitorList,
  LiveVisitorsQuery,
  VisitAck,
  VisitorInviteRequest,
  VisitorInviteResult,
  VisitorLinkRequest,
  VisitorLinkResponse,
  VisitorSettings,
  VisitorSettingsView,
  VisitReport,
} from './visitors.js';

const brandParams = z.object({ brandId: z.string().meta({ description: 'Brand ID (brd_…)' }) });

/** What the chat loader and the chat widget send about a visitor's browser. */
export const visitorWidgetRoutes = {
  reportVisit: {
    method: 'post',
    path: '/v1/widget/visits',
    operationId: 'reportVisit',
    summary:
      'The loader reports a page view, a sign of life or a page close; nothing is stored when the brand turned tracking off or the browser sends Do Not Track or Global Privacy Control. The same JSON may be sent as text/plain, which avoids a CORS preflight; readable only from the brand’s allowed websites',
    tags: ['Widget'],
    auth: 'public',
    body: VisitReport,
    success: { status: 200, description: 'Whether to keep reporting', schema: VisitAck },
  },
  linkVisitor: {
    method: 'post',
    path: '/v1/widget/visitors/link',
    operationId: 'linkVisitor',
    summary:
      'The widget says which browser it runs in, so staff see its pages next to the conversation; answers with the line that tells the visitor pages are noted',
    tags: ['Widget'],
    auth: 'widget_session',
    body: VisitorLinkRequest,
    success: { status: 200, description: 'Tracking state', schema: VisitorLinkResponse },
  },
} as const satisfies Record<string, RouteDef>;

/** Live visitors, the visitor card and the brand's visitor settings (Studio). */
export const visitorStaffRoutes = {
  listLiveVisitors: {
    method: 'get',
    path: '/v1/visitors/live',
    operationId: 'listLiveVisitors',
    summary:
      'Who is on the websites of the brands you can see right now, with page, time on site, country and device (conversations.read)',
    tags: ['Visitors'],
    auth: 'staff_session',
    query: LiveVisitorsQuery,
    success: { status: 200, description: 'Visitors on the site now', schema: LiveVisitorList },
  },
  inviteVisitor: {
    method: 'post',
    path: '/v1/visitors/{visitorId}/invite',
    operationId: 'inviteVisitor',
    summary:
      'Show a visitor a message next to the chat button, like a proactive prompt; it shows within seconds and expires after three minutes (conversations.reply)',
    tags: ['Visitors'],
    auth: 'staff_session',
    params: z.object({ visitorId: z.string().meta({ description: 'Visitor ID (vis_…)' }) }),
    body: VisitorInviteRequest,
    success: { status: 202, description: 'The invitation is waiting', schema: VisitorInviteResult },
  },
  getConversationVisitor: {
    method: 'get',
    path: '/v1/inbox/conversations/{conversationId}/visitor',
    operationId: 'getConversationVisitor',
    summary:
      'The pages, device, country and visit count of the browser the customer chatted from (conversations.read)',
    tags: ['Visitors'],
    auth: 'staff_session',
    params: z.object({
      conversationId: z.string().meta({ description: 'Conversation ID (conv_…)' }),
    }),
    success: { status: 200, description: 'The visitor card', schema: ConversationVisitor },
  },
  getVisitorSettings: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/visitor-settings',
    operationId: 'getVisitorSettings',
    summary: 'Whether the brand notes which pages visitors view (widget.configure)',
    tags: ['Visitors'],
    auth: 'staff_session',
    params: brandParams,
    success: { status: 200, description: 'Visitor settings', schema: VisitorSettingsView },
  },
  updateVisitorSettings: {
    method: 'put',
    path: '/v1/admin/brands/{brandId}/visitor-settings',
    operationId: 'updateVisitorSettings',
    summary:
      'Turn page tracking on or off and choose whether query strings are kept; it applies from each visitor’s next page view (widget.configure)',
    tags: ['Visitors'],
    auth: 'staff_session',
    params: brandParams,
    body: VisitorSettings,
    success: { status: 200, description: 'Visitor settings', schema: VisitorSettingsView },
  },
} as const satisfies Record<string, RouteDef>;
