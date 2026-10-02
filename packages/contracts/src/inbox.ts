import { z } from 'zod';
import { ClientMessageId, Cursor, LanguageTag, Timestamp } from './common.js';
import { CustomerConversationStatus, Message } from './conversations.js';
import { ErrorCode } from './errors.js';
import { typeId } from './ids.js';
import { Sender } from './participants.js';
import { SourcePart } from './parts.js';
import { OwnerMode } from './staff-conversations.js';

/**
 * The staff inbox (H01–H17). Conversations, messages, notes, assignment, tags and saved replies
 * live in the conversation authority; these shapes are the staff member's view of them, always
 * filtered by the member's grants. Nothing here is visible to customers.
 */

/** Which conversations a queue shows. */
export const InboxQueue = z.enum(['mine', 'unassigned', 'ai', 'team', 'all']);
export type InboxQueue = z.infer<typeof InboxQueue>;

/** `active` is everything open or pending (neither snoozed nor resolved). */
export const InboxStatusFilter = z.enum(['active', 'snoozed', 'resolved', 'all']);

export const AuthorityStatus = z.enum(['open', 'pending', 'resolved', 'snoozed']);

/** Where a conversation came in. */
export const InboxChannel = z.enum(['chat', 'email', 'whatsapp', 'sms', 'other']);

/** Why the conversation has its current owner (the latest ownership change). */
export const OwnerReason = z.enum([
  'staff_takeover',
  'staff_reply',
  'staff_assign',
  'staff_release',
  'return_to_ai',
  'customer_request',
  'authority_assignment',
  'authority_handoff',
  'human_reply',
  'no_agent',
  'assist_mode',
  'ai_stopped',
  'ai_unavailable',
  'ai_blocked',
  'ai_escalated',
]);
export type OwnerReason = z.infer<typeof OwnerReason>;

export const InboxOwner = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('ai'), displayName: z.string() }),
    z.object({
      kind: z.literal('staff'),
      staffMemberId: typeId('staff'),
      displayName: z.string(),
    }),
    /** A Chatwoot user without a Hamnivo account took it over inside Chatwoot. */
    z.object({ kind: z.literal('external'), displayName: z.string() }),
    z.object({ kind: z.literal('none') }),
  ])
  .meta({ id: 'InboxOwner' });
export type InboxOwner = z.infer<typeof InboxOwner>;

export const CustomerIdentity = z.enum(['verified', 'anonymous', 'unknown']);

export const InboxCustomer = z
  .object({
    displayName: z.string(),
    /** `verified`: signed in on the brand's website (tenant-signed assertion). */
    identity: CustomerIdentity,
    /** The customer's chosen language (BCP 47), when known. */
    language: LanguageTag.nullable(),
  })
  .meta({ id: 'InboxCustomer' });
export type InboxCustomer = z.infer<typeof InboxCustomer>;

export const InboxTeamRef = z.object({ id: typeId('team'), name: z.string() });

/** One row of the shared inbox. */
export const InboxConversation = z
  .object({
    id: typeId('conversation'),
    brand: z.object({ id: typeId('brand'), name: z.string() }).nullable(),
    inboxId: typeId('inbox'),
    channel: InboxChannel,
    status: AuthorityStatus,
    customerStatus: CustomerConversationStatus,
    ownerMode: OwnerMode,
    /** Increments on every owner change; send it back as `expectedEpoch` to refuse stale actions. */
    ownershipEpoch: z.int().nonnegative(),
    owner: InboxOwner,
    ownerReason: OwnerReason.nullable(),
    ownerChangedAt: Timestamp.nullable(),
    team: InboxTeamRef.nullable(),
    customer: InboxCustomer,
    lastMessage: z
      .object({
        preview: z.string().max(200),
        at: Timestamp,
        from: z.enum(['customer', 'ai', 'staff', 'system']),
      })
      .nullable(),
    labels: z.array(z.string()),
    snoozedUntil: Timestamp.nullable(),
    /** When the customer last wrote while nobody has answered yet (waiting for a person). */
    waitingSince: Timestamp.nullable(),
    lastActivityAt: Timestamp,
    createdAt: Timestamp,
  })
  .meta({ id: 'InboxConversation' });
export type InboxConversation = z.infer<typeof InboxConversation>;

export const InboxCounts = z
  .object({
    mine: z.int().nonnegative(),
    unassigned: z.int().nonnegative(),
    ai: z.int().nonnegative(),
    team: z.int().nonnegative(),
    all: z.int().nonnegative(),
  })
  .meta({ id: 'InboxCounts' });
export type InboxCounts = z.infer<typeof InboxCounts>;

export const InboxListQuery = z.object({
  queue: InboxQueue.default('all'),
  status: InboxStatusFilter.default('active'),
  brandId: typeId('brand').optional(),
  channel: InboxChannel.optional(),
  language: LanguageTag.optional(),
  label: z.string().min(1).max(255).optional(),
  teamId: typeId('team').optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export const InboxPage = z
  .object({
    items: z.array(InboxConversation),
    nextCursor: Cursor.nullable(),
    /** Counts per queue with the same status and filters (active conversations by default). */
    counts: InboxCounts,
  })
  .meta({ id: 'InboxPage' });
export type InboxPage = z.infer<typeof InboxPage>;

export const PresenceLane = z.enum(['public', 'internal']);

export const PresenceEntry = z
  .object({
    staffMemberId: typeId('staff'),
    displayName: z.string(),
    state: z.enum(['viewing', 'typing']),
    lane: PresenceLane.nullable(),
    since: Timestamp,
  })
  .meta({ id: 'PresenceEntry' });
export type PresenceEntry = z.infer<typeof PresenceEntry>;

export const PresenceUpdate = z
  .object({
    state: z.enum(['viewing', 'typing', 'left']),
    lane: PresenceLane.optional(),
  })
  .meta({ id: 'PresenceUpdate' });

/** What the signed-in staff member may do in this conversation (computed on the server). */
export const InboxPermissions = z
  .object({
    reply: z.boolean(),
    note: z.boolean(),
    takeover: z.boolean(),
    assign: z.boolean(),
    status: z.boolean(),
    tag: z.boolean(),
    review: z.boolean(),
    bulk: z.boolean(),
  })
  .meta({ id: 'InboxPermissions' });
export type InboxPermissions = z.infer<typeof InboxPermissions>;

export const InboxConversationDetail = InboxConversation.extend({
  permissions: InboxPermissions,
  /** Other staff members looking at or typing in this conversation right now. */
  presence: z.array(PresenceEntry),
  /** Whether handing the conversation back to the AI can work right now. */
  aiAvailable: z.boolean(),
}).meta({ id: 'InboxConversationDetail' });
export type InboxConversationDetail = z.infer<typeof InboxConversationDetail>;

/** A message in the staff view: public messages, internal notes and activity lines. */
export const InboxMessage = Message.extend({
  /** `activity`: a status or assignment line; `hamnivo_note`: a note Hamnivo wrote (handoff). */
  system: z.enum(['activity', 'hamnivo_note']).nullable(),
  /** Written by the signed-in staff member. */
  mine: z.boolean(),
}).meta({ id: 'InboxMessage' });
export type InboxMessage = z.infer<typeof InboxMessage>;

export const InboxMessagePage = z
  .object({
    /** Newest first. */
    items: z.array(InboxMessage),
    olderCursor: Cursor.nullable(),
  })
  .meta({ id: 'InboxMessagePage' });
export type InboxMessagePage = z.infer<typeof InboxMessagePage>;

export const InboxMessagesQuery = z.object({
  before: Cursor.optional(),
});

// ------------------------------------------------------------------ assignment (H02, H08)

export const AssignTarget = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('me') }),
    z.object({ kind: z.literal('staff'), staffMemberId: typeId('staff') }),
    /** Back to the queue: waiting for a person. */
    z.object({ kind: z.literal('queue') }),
    z.object({ kind: z.literal('ai') }),
  ])
  .meta({ id: 'AssignTarget' });

export const AssignRequest = z
  .object({
    to: AssignTarget,
    /** The epoch the caller saw; if someone else changed the owner since, nothing happens (409). */
    expectedEpoch: z.int().nonnegative().optional(),
  })
  .meta({ id: 'AssignRequest' });

export const TeamAssignRequest = z
  .object({ teamId: typeId('team').nullable() })
  .meta({ id: 'TeamAssignRequest' });

export const AssigneeOptions = z
  .object({
    staff: z.array(
      z.object({
        staffMemberId: typeId('staff'),
        displayName: z.string(),
        current: z.boolean(),
      }),
    ),
    teams: z.array(InboxTeamRef),
    ai: z.object({ available: z.boolean(), displayName: z.string().nullable() }),
  })
  .meta({ id: 'AssigneeOptions' });
export type AssigneeOptions = z.infer<typeof AssigneeOptions>;

export const TransferRequest = z
  .object({
    clientRequestId: z.uuid(),
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'TransferRequest' });

// ------------------------------------------------------------------ status (H10)

export const StatusRequest = z
  .object({
    status: z.enum(['open', 'resolved', 'snoozed']),
    /** For `snoozed`: when it opens again. Omitted: when the customer writes next. */
    snoozedUntil: Timestamp.optional(),
    expectedEpoch: z.int().nonnegative().optional(),
  })
  .meta({ id: 'StatusRequest' });

// ------------------------------------------------------------------ tags and fields (H04)

export const LabelOption = z
  .object({
    title: z.string(),
    description: z.string().nullable(),
    color: z.string().nullable(),
  })
  .meta({ id: 'LabelOption' });
export type LabelOption = z.infer<typeof LabelOption>;

export const ConversationTags = z
  .object({
    labels: z.array(z.string()),
    /** The tags this brand defined; only these can be added. */
    options: z.array(LabelOption),
  })
  .meta({ id: 'ConversationTags' });
export type ConversationTags = z.infer<typeof ConversationTags>;

export const SetTagsRequest = z
  .object({ labels: z.array(z.string().trim().min(1).max(255)).max(30) })
  .meta({ id: 'SetTagsRequest' });

export const FieldType = z.enum([
  'text',
  'number',
  'currency',
  'percent',
  'link',
  'date',
  'list',
  'checkbox',
]);

export const FieldValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

export const CustomFieldDefinition = z
  .object({
    key: z.string(),
    name: z.string(),
    type: FieldType,
    description: z.string().nullable(),
    /** Allowed values for `list` fields. */
    options: z.array(z.string()),
  })
  .meta({ id: 'CustomFieldDefinition' });
export type CustomFieldDefinition = z.infer<typeof CustomFieldDefinition>;

export const ConversationFields = z
  .object({
    definitions: z.array(CustomFieldDefinition),
    values: z.record(z.string(), FieldValue),
  })
  .meta({ id: 'ConversationFields' });
export type ConversationFields = z.infer<typeof ConversationFields>;

export const SetFieldsRequest = z
  .object({
    /** Fields to change; `null` clears one. Other fields keep their values. */
    values: z.record(z.string().min(1).max(100), FieldValue),
  })
  .meta({ id: 'SetFieldsRequest' });

// ------------------------------------------------------------------ saved replies (H05)

export const SavedReply = z
  .object({
    id: typeId('savedReply'),
    shortCode: z.string(),
    content: z.string(),
    /** The content with this conversation's details filled in. */
    preview: z.string(),
    /** Variables that could not be filled in (left as written in the preview). */
    missingVariables: z.array(z.string()),
  })
  .meta({ id: 'SavedReply' });
export type SavedReply = z.infer<typeof SavedReply>;

export const SavedReplyList = z
  .object({ items: z.array(SavedReply) })
  .meta({ id: 'SavedReplyList' });

export const SavedRepliesQuery = z.object({ q: z.string().trim().max(100).optional() });

export const CreateSavedReplyRequest = z
  .object({
    shortCode: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[\p{L}\p{N}_-]+$/u, 'Letters, numbers, - and _ only'),
    content: z.string().trim().min(1).max(5000),
  })
  .meta({ id: 'CreateSavedReplyRequest' });

// ------------------------------------------------------------------ customer context (H06)

export const CustomerContext = z
  .object({
    displayName: z.string(),
    identity: CustomerIdentity,
    /** The customer's user id on the brand's website (verified customers only). */
    externalId: z.string().nullable(),
    /** Only an address the website verified; never a typed-in one. */
    email: z.string().nullable(),
    /** An address the customer typed in; shown as not verified. */
    unverifiedEmail: z.string().nullable(),
    language: LanguageTag.nullable(),
    brand: z.object({ id: typeId('brand'), name: z.string() }).nullable(),
    customerSince: Timestamp.nullable(),
    lastSeenAt: Timestamp.nullable(),
    attributes: z.array(z.object({ key: z.string(), value: z.string() })),
    previousConversations: z.array(
      z.object({
        id: typeId('conversation'),
        status: AuthorityStatus,
        lastActivityAt: Timestamp,
        preview: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'CustomerContext' });
export type CustomerContext = z.infer<typeof CustomerContext>;

// ------------------------------------------------------------------ search (H07)

export const InboxSearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  cursor: Cursor.optional(),
});

export const InboxSearchResult = z
  .object({
    conversations: z.array(InboxConversation),
    messages: z.array(
      z.object({
        conversationId: typeId('conversation'),
        messageId: z.string(),
        snippet: z.string().max(300),
        visibility: z.enum(['public', 'internal']),
        sender: Sender,
        createdAt: Timestamp,
      }),
    ),
    nextCursor: Cursor.nullable(),
  })
  .meta({ id: 'InboxSearchResult' });
export type InboxSearchResult = z.infer<typeof InboxSearchResult>;

// ------------------------------------------------------------------ drafts and failed sends (H09)

export const DraftLane = z.enum(['public', 'internal']);
export type DraftLane = z.infer<typeof DraftLane>;

export const StaffDraft = z
  .object({
    lane: DraftLane,
    text: z.string(),
    /** Increments on every save; saving over a newer revision is a conflict (another tab). */
    revision: z.int().positive(),
    updatedAt: Timestamp,
  })
  .meta({ id: 'StaffDraft' });
export type StaffDraft = z.infer<typeof StaffDraft>;

/** A send that has not been confirmed. Retrying reuses its client message id, so it is safe. */
export const OutgoingMessage = z
  .object({
    clientMessageId: ClientMessageId,
    lane: DraftLane,
    text: z.string(),
    state: z.enum(['sending', 'failed']),
    errorCode: ErrorCode.nullable(),
    updatedAt: Timestamp,
  })
  .meta({ id: 'OutgoingMessage' });
export type OutgoingMessage = z.infer<typeof OutgoingMessage>;

export const DraftsView = z
  .object({ drafts: z.array(StaffDraft), outgoing: z.array(OutgoingMessage) })
  .meta({ id: 'DraftsView' });
export type DraftsView = z.infer<typeof DraftsView>;

export const SaveDraftRequest = z
  .object({
    text: z.string().max(10_000),
    /** The revision this edit started from; omitted for a new draft. */
    baseRevision: z.int().positive().optional(),
  })
  .meta({ id: 'SaveDraftRequest' });

// ------------------------------------------------------------------ AI copilot (H11)

export const CopilotRequest = z
  .object({ clientRequestId: z.uuid() })
  .meta({ id: 'CopilotRequest' });

/** A suggested reply for the staff member. It is never sent by itself. */
export const CopilotSuggestion = z
  .object({
    /** The run that produced it (see Runs). */
    id: typeId('run'),
    text: z.string(),
    sources: z.array(SourcePart),
    agentName: z.string(),
    createdAt: Timestamp,
  })
  .meta({ id: 'CopilotSuggestion' });
export type CopilotSuggestion = z.infer<typeof CopilotSuggestion>;

// ------------------------------------------------------------------ translation (H13)

export const TranslateRequest = z
  .object({ targetLanguage: LanguageTag })
  .meta({ id: 'TranslateRequest' });

export const MessageTranslation = z
  .object({
    messageId: z.string(),
    targetLanguage: LanguageTag,
    text: z.string(),
    /** Always true: machine translation, shown next to the original. */
    machine: z.literal(true),
    provider: z.string(),
    model: z.string(),
  })
  .meta({ id: 'MessageTranslation' });
export type MessageTranslation = z.infer<typeof MessageTranslation>;

// ------------------------------------------------------------------ supervisor review (H14)

export const ReviewRequest = z
  .object({
    rating: z.int().min(1).max(5),
    note: z.string().trim().max(2000).optional(),
    /** The staff member whose handling is reviewed. */
    subjectStaffMemberId: typeId('staff').optional(),
  })
  .meta({ id: 'ReviewRequest' });

export const ConversationReview = z
  .object({
    id: typeId('review'),
    rating: z.int().min(1).max(5),
    note: z.string().nullable(),
    reviewer: z.object({ staffMemberId: typeId('staff'), displayName: z.string() }),
    subject: z.object({ staffMemberId: typeId('staff'), displayName: z.string() }).nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: 'ConversationReview' });
export type ConversationReview = z.infer<typeof ConversationReview>;

// ------------------------------------------------------------------ bulk operations (H15)

export const BulkAction = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('assign'), to: AssignTarget }),
    z.object({ type: z.literal('team'), teamId: typeId('team').nullable() }),
    z.object({
      type: z.literal('status'),
      status: z.enum(['open', 'resolved', 'snoozed']),
      snoozedUntil: Timestamp.optional(),
    }),
    z.object({
      type: z.literal('tags'),
      add: z.array(z.string().trim().min(1).max(255)).max(10).default([]),
      remove: z.array(z.string().trim().min(1).max(255)).max(10).default([]),
    }),
  ])
  .meta({ id: 'BulkAction' });

export const BulkRequest = z
  .object({
    conversationIds: z.array(typeId('conversation')).min(1).max(50),
    action: BulkAction,
    /** Check each conversation without changing anything. */
    dryRun: z.boolean().default(false),
  })
  .meta({ id: 'BulkRequest' });

export const BulkResult = z
  .object({
    dryRun: z.boolean(),
    results: z.array(
      z.object({
        conversationId: z.string(),
        outcome: z.enum(['done', 'unchanged', 'eligible', 'failed']),
        code: ErrorCode.nullable(),
        detail: z.string().nullable(),
      }),
    ),
    summary: z.object({
      done: z.int().nonnegative(),
      unchanged: z.int().nonnegative(),
      eligible: z.int().nonnegative(),
      failed: z.int().nonnegative(),
    }),
  })
  .meta({ id: 'BulkResult' });
export type BulkResult = z.infer<typeof BulkResult>;

// ------------------------------------------------------------------ linked cases (H17)

export const LinkRequest = z
  .object({
    conversationId: typeId('conversation'),
    note: z.string().trim().max(300).optional(),
  })
  .meta({ id: 'LinkRequest' });

export const ConversationLink = z
  .object({
    id: typeId('link'),
    conversation: z.object({
      id: typeId('conversation'),
      customerName: z.string(),
      status: AuthorityStatus,
      lastActivityAt: Timestamp,
    }),
    note: z.string().nullable(),
    createdBy: z.object({ staffMemberId: typeId('staff'), displayName: z.string() }),
    createdAt: Timestamp,
  })
  .meta({ id: 'ConversationLink' });
export type ConversationLink = z.infer<typeof ConversationLink>;

// ------------------------------------------------------------------ teams (H02)

export const Team = z
  .object({
    id: typeId('team'),
    name: z.string(),
    workspaceId: typeId('workspace').nullable(),
    status: z.enum(['active', 'archived']),
    members: z.array(z.object({ staffMemberId: typeId('staff'), displayName: z.string() })),
    createdAt: Timestamp,
  })
  .meta({ id: 'Team' });
export type Team = z.infer<typeof Team>;

export const CreateTeamRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    workspaceId: typeId('workspace').nullable().default(null),
  })
  .meta({ id: 'CreateTeamRequest' });

export const SetTeamMembersRequest = z
  .object({ staffMemberIds: z.array(typeId('staff')).max(200) })
  .meta({ id: 'SetTeamMembersRequest' });

// ------------------------------------------------------------------ live updates

/** Events on the staff inbox stream. They are signals: clients reload what changed. */
export const InboxStreamEvent = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('inbox.changed'), conversationIds: z.array(z.string()) }),
    z.object({
      type: z.literal('presence'),
      conversationId: z.string(),
      viewers: z.array(PresenceEntry),
    }),
  ])
  .meta({ id: 'InboxStreamEvent' });
export type InboxStreamEvent = z.infer<typeof InboxStreamEvent>;
