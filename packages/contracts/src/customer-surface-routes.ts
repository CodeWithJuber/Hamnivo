import { z } from 'zod';
import { SupportedLocale } from './common.js';
import { SendMessageResponse } from './conversations.js';
import {
  HelpSearchResponse,
  LauncherConfig,
  MessageDeletion,
  NotificationPreferences,
  ProactiveSettingsView,
  ReactionRequest,
  UnsubscribeQuery,
  UpdateNotificationPreferencesRequest,
  UpdateProactiveSettingsRequest,
  UpdateWidgetSettingsRequest,
  WidgetSettingsView,
} from './customer-surface.js';
import type { RouteDef } from './routes.js';

const conversationParams = z.object({
  conversationId: z.string().meta({ description: 'Conversation ID (conv_…)' }),
});
const messageParams = conversationParams.extend({
  messageId: z.string().meta({ description: 'Message ID (msg_…)' }),
});
const brandParams = z.object({ brandId: z.string().meta({ description: 'Brand ID (brd_…)' }) });

/** The customer surface of the widget API (W02, W09, W17, W22, W23, W25). */
export const customerSurfaceWidgetRoutes = {
  launcherConfig: {
    method: 'get',
    path: '/v1/widget/launcher',
    operationId: 'getLauncherConfig',
    summary:
      'Layout, launcher colours and labels, and proactive prompts for the loader; readable from the brand’s allowed websites only',
    tags: ['Widget'],
    auth: 'public',
    query: z.object({
      widgetId: z.string().meta({ description: 'Widget ID (wid_…)' }),
      locale: SupportedLocale.optional(),
    }),
    success: { status: 200, description: 'Launcher configuration', schema: LauncherConfig },
  },
  downloadAttachment: {
    method: 'get',
    path: '/v1/widget/conversations/{conversationId}/attachments/{attachmentId}',
    operationId: 'downloadAttachment',
    summary:
      'A file sent in one of my conversations, after its scan passed; authorization is checked on every download',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversationParams.extend({
      attachmentId: z.string().meta({ description: 'Attachment ID (upl_…)' }),
    }),
    success: {
      status: 200,
      description: 'The file (Content-Type detected from its bytes; always a download)',
      schema: z.string().meta({ format: 'binary' }),
      contentType: 'application/octet-stream',
    },
  },
  deleteMessage: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/messages/{messageId}/delete',
    operationId: 'deleteMyMessage',
    summary:
      'Delete one of my own messages within the brand’s deletion window, where the conversation authority can',
    tags: ['Widget'],
    auth: 'widget_session',
    params: messageParams,
    success: { status: 200, description: 'Deleted', schema: MessageDeletion },
  },
  react: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/messages/{messageId}/reactions',
    operationId: 'reactToMessage',
    summary:
      'React to a reply; without reactions in the authority it is sent as a short reply quoting the message',
    tags: ['Widget'],
    auth: 'widget_session',
    params: messageParams,
    body: ReactionRequest,
    success: {
      status: 202,
      description: 'Accepted after the conversation authority committed it',
      schema: SendMessageResponse,
    },
  },
  helpSearch: {
    method: 'get',
    path: '/v1/widget/help/search',
    operationId: 'searchHelp',
    summary: 'Search the brand’s public knowledge before a conversation starts',
    tags: ['Widget'],
    auth: 'widget_session',
    query: z.object({ q: z.string().trim().min(2).max(200) }),
    success: { status: 200, description: 'Matching articles', schema: HelpSearchResponse },
  },
  getNotificationPreferences: {
    method: 'get',
    path: '/v1/widget/notifications',
    operationId: 'getNotificationPreferences',
    summary: 'My email notification choices, and whether they are available to me',
    tags: ['Widget'],
    auth: 'widget_session',
    success: { status: 200, description: 'Preferences', schema: NotificationPreferences },
  },
  updateNotificationPreferences: {
    method: 'post',
    path: '/v1/widget/notifications',
    operationId: 'updateNotificationPreferences',
    summary: 'Turn transcript or reply-waiting emails on or off (verified customers only)',
    tags: ['Widget'],
    auth: 'widget_session',
    body: UpdateNotificationPreferencesRequest,
    success: { status: 200, description: 'Preferences', schema: NotificationPreferences },
  },
} as const satisfies Record<string, RouteDef>;

/** Unsubscribe links in customer emails (W25): a signed token, no session. */
export const notificationRoutes = {
  unsubscribePage: {
    method: 'get',
    path: '/v1/notifications/unsubscribe',
    operationId: 'unsubscribePage',
    summary: 'The page an unsubscribe link opens; it asks before changing anything',
    tags: ['Notifications'],
    auth: 'public',
    query: UnsubscribeQuery,
    success: {
      status: 200,
      description: 'An HTML page with a confirmation button',
      schema: z.string(),
      contentType: 'text/html',
    },
  },
  unsubscribe: {
    method: 'post',
    path: '/v1/notifications/unsubscribe',
    operationId: 'unsubscribe',
    summary: 'Stop the emails a signed link names (also RFC 8058 one-click unsubscribe)',
    tags: ['Notifications'],
    auth: 'public',
    query: UnsubscribeQuery,
    success: {
      status: 200,
      description: 'An HTML page confirming the change',
      schema: z.string(),
      contentType: 'text/html',
    },
  },
} as const satisfies Record<string, RouteDef>;

/** Brand settings for the customer surface (Studio and the admin API). */
export const customerSurfaceAdminRoutes = {
  getWidgetSettings: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/widget-settings',
    operationId: 'getWidgetSettings',
    summary: 'Layout, files, help home, deletion window and email offers (widget.configure)',
    tags: ['Admin'],
    auth: 'staff_session',
    params: brandParams,
    success: { status: 200, description: 'Widget settings', schema: WidgetSettingsView },
  },
  updateWidgetSettings: {
    method: 'put',
    path: '/v1/admin/brands/{brandId}/widget-settings',
    operationId: 'updateWidgetSettings',
    summary: 'Replace the widget settings; the widget picks them up at once (widget.configure)',
    tags: ['Admin'],
    auth: 'staff_session',
    params: brandParams,
    body: UpdateWidgetSettingsRequest,
    success: { status: 200, description: 'Widget settings', schema: WidgetSettingsView },
  },
  getProactiveSettings: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/proactive',
    operationId: 'getProactiveSettings',
    summary: 'Proactive prompts on the brand’s website (widget.proactive)',
    tags: ['Admin'],
    auth: 'staff_session',
    params: brandParams,
    success: { status: 200, description: 'Proactive settings', schema: ProactiveSettingsView },
  },
  updateProactiveSettings: {
    method: 'put',
    path: '/v1/admin/brands/{brandId}/proactive',
    operationId: 'updateProactiveSettings',
    summary: 'Replace the proactive prompts; off until turned on (widget.proactive)',
    tags: ['Admin'],
    auth: 'staff_session',
    params: brandParams,
    body: UpdateProactiveSettingsRequest,
    success: { status: 200, description: 'Proactive settings', schema: ProactiveSettingsView },
  },
} as const satisfies Record<string, RouteDef>;
