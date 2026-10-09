import { z } from 'zod';
import { ClientMessageId, Timestamp } from './common.js';
import { CustomerConversationStatus } from './conversations.js';
import { typeId } from './ids.js';

/** Who may speak publicly in a conversation right now (ADR 0003). */
export const OwnerMode = z.enum(['AI_ACTIVE', 'WAITING_HUMAN', 'HUMAN_ACTIVE', 'PAUSED']);
export type OwnerMode = z.infer<typeof OwnerMode>;

/** Staff view of a conversation's control state. Messages stay in the conversation authority. */
export const StaffConversation = z
  .object({
    id: typeId('conversation'),
    brandId: typeId('brand').nullable(),
    ownerMode: OwnerMode,
    /** Increments on every owner change; AI publications carry the epoch they were started under. */
    ownershipEpoch: z.int().nonnegative(),
    owner: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('ai') }),
      z.object({ kind: z.literal('staff'), staffMemberId: typeId('staff') }),
      z.object({ kind: z.literal('external'), displayName: z.string() }),
      z.object({ kind: z.literal('none') }),
    ]),
    customerStatus: CustomerConversationStatus,
    authorityStatus: z.enum(['open', 'pending', 'resolved', 'snoozed']),
    lastActivityAt: Timestamp,
  })
  .meta({ id: 'StaffConversation' });
export type StaffConversation = z.infer<typeof StaffConversation>;

export const TakeoverRequest = z
  .object({
    /** The epoch the caller saw; a stale value returns OWNERSHIP_CHANGED instead of overriding. */
    expectedEpoch: z.int().nonnegative().optional(),
  })
  .meta({ id: 'TakeoverRequest' });

const TemplateValueMap = z.record(z.string().max(64), z.string().max(1000));

/** A WhatsApp template to send (D14), with the values staff filled in. */
export const TemplateMessage = z
  .object({
    name: z.string().min(1).max(512),
    /** Meta's language code, such as `en_US`. */
    language: z.string().min(1).max(32),
    /** By variable (`1`, or a name); buttons by their position. */
    values: z
      .object({
        header: TemplateValueMap.optional(),
        body: TemplateValueMap.optional(),
        buttons: TemplateValueMap.optional(),
      })
      .default({}),
  })
  .meta({ id: 'TemplateMessage' });

export const StaffMessageRequest = z
  .object({
    clientMessageId: ClientMessageId,
    /** The message. Leave it out when sending a template: the server renders its text. */
    text: z.string().trim().min(1).max(10_000).optional(),
    /** `internal` writes a private note that customers never see. */
    visibility: z.enum(['public', 'internal']).default('public'),
    /**
     * The ownership epoch the sender saw. A public reply is refused (OWNERSHIP_CHANGED) when the
     * owner changed since, so a reply written in a stale view is never sent.
     */
    expectedEpoch: z.int().nonnegative().optional(),
    /** Remove the sender's saved draft for this lane once the message is on its way. */
    clearDraft: z.boolean().default(false),
    /** The AI suggestion this reply started from (recorded for audit; it is still your reply). */
    suggestionId: typeId('run').optional(),
    /**
     * WhatsApp: an approved template instead of text (D14). Allowed at any time, including more
     * than 24 hours after the customer last wrote, when free text is not.
     */
    template: TemplateMessage.optional(),
  })
  .refine((r) => (r.text === undefined) !== (r.template === undefined), {
    message: 'Send either text or a template.',
    path: ['text'],
  })
  .refine((r) => !r.template || r.visibility === 'public', {
    message: 'A template is a reply to the customer, never an internal note.',
    path: ['template'],
  })
  .meta({ id: 'StaffMessageRequest' });

/** One of the WhatsApp templates approved for the conversation's number (D14). */
export const WhatsappTemplateView = z
  .object({
    name: z.string(),
    language: z.string(),
    /** `UTILITY`, `MARKETING` or `AUTHENTICATION`. */
    category: z.string(),
    /** The header's text, with its `{{…}}` variables; null when it has none or it is media. */
    header: z.string().nullable(),
    body: z.string(),
    footer: z.string().nullable(),
    buttons: z.array(
      z.object({
        type: z.enum(['quick_reply', 'url', 'phone_number', 'copy_code', 'other']),
        text: z.string(),
      }),
    ),
    /** What staff fill in before sending. */
    variables: z.object({
      header: z.array(z.string()),
      body: z.array(z.string()),
      buttons: z.array(
        z.object({
          index: z.int().nonnegative(),
          type: z.enum(['url', 'copy_code']),
          label: z.string(),
        }),
      ),
    }),
    /**
     * Why it cannot be sent from Hamnivo: not approved by Meta yet, a one-time-code template, or
     * an image, video or document header. Null when it can.
     */
    unsupported: z.enum(['not_approved', 'authentication', 'media_header']).nullable(),
  })
  .meta({ id: 'WhatsappTemplate' });
export type WhatsappTemplateView = z.infer<typeof WhatsappTemplateView>;

export const WhatsappTemplateList = z
  .object({
    items: z.array(WhatsappTemplateView),
    /** Free text can be sent now; otherwise only a template. */
    windowOpen: z.boolean(),
    windowClosesAt: Timestamp.nullable(),
    /** When Chatwoot last fetched the templates from Meta; a new template shows after that. */
    lastSyncedAt: Timestamp.nullable(),
  })
  .meta({ id: 'WhatsappTemplateList' });
export type WhatsappTemplateList = z.infer<typeof WhatsappTemplateList>;

export const StaffMessageResponse = z
  .object({
    messageId: typeId('message'),
    status: z.enum(['accepted', 'duplicate']),
  })
  .meta({ id: 'StaffMessageResponse' });
