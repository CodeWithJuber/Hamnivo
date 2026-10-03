import { z } from 'zod';
import {
  AvailabilityPing,
  InboxPreferences,
  SetAvailabilityRequest,
  StaffAvailability,
  TypingRequest,
  UnreadSummary,
  UpdateInboxAlertSettings,
} from './inbox-alerts.js';
import type { RouteDef } from './routes.js';

const conversation = z.object({
  conversationId: z.string().meta({ description: 'Conversation ID (conv_…)' }),
});
const tag = ['Inbox'];

/**
 * Alerts, unread chats, availability and typing in the staff inbox. Every staff route needs
 * X-Hamnivo-Tenant and `conversations.read` somewhere; what a person chose here is theirs alone.
 */
export const inboxAlertRoutes = {
  getInboxPreferences: {
    method: 'get',
    path: '/v1/inbox/preferences',
    operationId: 'getInboxPreferences',
    summary: 'Your alert sounds, desktop alerts and availability (conversations.read)',
    tags: tag,
    auth: 'staff_session',
    success: { status: 200, description: 'Your inbox preferences', schema: InboxPreferences },
  },
  updateInboxAlertSettings: {
    method: 'patch',
    path: '/v1/inbox/preferences',
    operationId: 'updateInboxAlertSettings',
    summary: 'Change what you hear and see when customers write; only what you send changes',
    tags: tag,
    auth: 'staff_session',
    body: UpdateInboxAlertSettings,
    success: { status: 200, description: 'Your inbox preferences', schema: InboxPreferences },
  },
  setAvailability: {
    method: 'put',
    path: '/v1/inbox/availability',
    operationId: 'setAvailability',
    summary: 'Say whether you are online, away or offline',
    tags: tag,
    auth: 'staff_session',
    body: SetAvailabilityRequest,
    success: { status: 200, description: 'Your availability', schema: StaffAvailability },
  },
  pingAvailability: {
    method: 'post',
    path: '/v1/inbox/availability/ping',
    operationId: 'pingAvailability',
    summary:
      'Studio’s sign of life while it is open; without one for a few minutes you show as offline',
    tags: tag,
    auth: 'staff_session',
    body: AvailabilityPing,
    success: { status: 200, description: 'Your availability', schema: StaffAvailability },
  },
  getUnreadSummary: {
    method: 'get',
    path: '/v1/inbox/unread',
    operationId: 'getUnreadSummary',
    summary:
      'How many chats need you: yours or waiting for a person, with customer messages you have not read (conversations.read)',
    tags: tag,
    auth: 'staff_session',
    success: { status: 200, description: 'Unread chats', schema: UnreadSummary },
  },
  markConversationRead: {
    method: 'post',
    path: '/v1/inbox/conversations/{conversationId}/read',
    operationId: 'markConversationRead',
    summary: 'Mark the customer’s messages so far as read by you (conversations.read)',
    tags: tag,
    auth: 'staff_session',
    params: conversation,
    success: { status: 204, description: 'Marked as read' },
  },
  reportTyping: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/typing',
    operationId: 'reportTyping',
    summary:
      'Tell staff the customer is typing (send every few seconds while they type, and false when they stop)',
    tags: ['Widget'],
    auth: 'widget_session',
    params: conversation,
    body: TypingRequest,
    success: { status: 204, description: 'Recorded' },
  },
} as const satisfies Record<string, RouteDef>;
