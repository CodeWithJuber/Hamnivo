import { z } from 'zod';
import { ClientMessageId, Timestamp, Visibility } from './common.js';
import { Sender } from './participants.js';
import { AttachmentPart, MessagePart, TextPart } from './parts.js';

/** Delivery states shown to a sender (W06). "delivered"/"read" only where the channel supports them. */
export const DeliveryState = z.enum([
  'queued',
  'sending',
  'accepted',
  'delivered',
  'read',
  'failed',
]);
export type DeliveryState = z.infer<typeof DeliveryState>;

export const Message = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    /** Position in the conversation journal (delivery order); absent for pages served from history only. */
    sequence: z.int().nonnegative().nullable(),
    sender: Sender,
    visibility: Visibility,
    parts: z.array(MessagePart).min(1),
    createdAt: Timestamp,
    /** Present on the sender's own messages so optimistic bubbles can be reconciled. */
    clientMessageId: ClientMessageId.nullable(),
    delivery: DeliveryState.nullable(),
    /** BCP 47 tag of the original text when known (translations are separate, labelled views). */
    language: z.string().nullable(),
  })
  .meta({ id: 'Message' });
export type Message = z.infer<typeof Message>;

/** Customer-facing conversation state. Staff-only fields (epoch, assignee) are never included. */
export const CustomerConversationStatus = z.enum([
  'open',
  'waiting_for_person',
  'with_person',
  'resolved',
]);

export const CustomerConversation = z
  .object({
    id: z.string(),
    status: CustomerConversationStatus,
    /** Who currently answers: an AI assistant, a person, or nobody yet. */
    responder: z.enum(['ai', 'person', 'none']),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    unreadCount: z.int().nonnegative(),
    lastMessagePreview: z.string().max(200).nullable(),
    /** Latest journal sequence the server has for this conversation. */
    latestSequence: z.int().nonnegative(),
  })
  .meta({ id: 'CustomerConversation' });
export type CustomerConversation = z.infer<typeof CustomerConversation>;

/** Untrusted page context from the host site: references are verified server-side before use. */
export const PageContext = z
  .object({
    url: z.url().max(2000).optional(),
    title: z.string().max(300).optional(),
    pageType: z.string().max(60).optional(),
    references: z
      .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), z.string().max(200))
      .optional(),
  })
  .meta({ id: 'PageContext' });

export const SendMessageRequest = z
  .object({
    clientMessageId: ClientMessageId,
    parts: z
      .array(
        z.discriminatedUnion('type', [
          TextPart,
          AttachmentPart.pick({ type: true, uploadId: true }).extend({
            type: z.literal('attachment'),
          }),
        ]),
      )
      .min(1)
      .max(10),
    context: PageContext.optional(),
  })
  .meta({ id: 'SendMessageRequest' });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z
  .object({
    message: Message,
    /** `accepted`: durably committed by the conversation authority. `duplicate`: a retry of an accepted send. */
    status: z.enum(['accepted', 'duplicate']),
  })
  .meta({ id: 'SendMessageResponse' });
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const StartConversationRequest = z
  .object({
    clientMessageId: ClientMessageId.optional(),
    firstMessage: z.string().min(1).max(10_000).optional(),
    context: PageContext.optional(),
  })
  .meta({ id: 'StartConversationRequest' });

export const MessagePage = z
  .object({
    items: z.array(Message),
    /** Pass as `before` to load older messages; null at the beginning of the conversation. */
    olderCursor: z.string().nullable(),
    /** Highest sequence included; resume the event stream after it. */
    latestSequence: z.int().nonnegative(),
  })
  .meta({ id: 'MessagePage' });
export type MessagePage = z.infer<typeof MessagePage>;

export const HandoffRequest = z
  .object({
    /** Optional free text from the customer ("I want to talk to a person about my refund"). */
    note: z.string().max(1000).optional(),
    clientRequestId: z.uuid(),
  })
  .meta({ id: 'HandoffRequest' });

export const HandoffResponse = z
  .object({
    handoffId: z.string(),
    /** Honest availability: never a fabricated queue position (W11, R12). */
    availability: z.enum(['person_available', 'queued', 'offline']),
    /** Localized, factual next-step message for the customer. */
    message: z.string(),
    followUp: z
      .object({ channel: z.enum(['email', 'this_chat']), expectedBy: Timestamp.nullable() })
      .nullable(),
  })
  .meta({ id: 'HandoffResponse' });
export type HandoffResponse = z.infer<typeof HandoffResponse>;

export const FeedbackRequest = z
  .object({
    rating: z.int().min(1).max(5),
    comment: z.string().max(2000).optional(),
  })
  .meta({ id: 'FeedbackRequest' });

export const ReadReceiptRequest = z
  .object({ upToSequence: z.int().nonnegative() })
  .meta({ id: 'ReadReceiptRequest' });
