import { z } from 'zod';
import { Timestamp } from './common.js';
import { LocalizedText } from './customer-surface.js';
import { TicketPriority } from './tickets.js';

/**
 * Automations (G21): "When … If … Then …" rules a brand writes in Studio. Rules on the website
 * (`visitor`) show a prompt next to the launcher and replace the old proactive triggers (W19);
 * rules in chats (`conversation`) reply, tag, prioritise, route or make a ticket. A rule is edited
 * as a draft and runs only once published; each publication is kept as a version.
 *
 * The shapes here mirror `@hamnivo/domain/automations`, which evaluates them. What a shape cannot
 * say (a condition its kind cannot use, a message that could interrupt the AI) is checked by the
 * gateway with the domain's `definitionProblems` and returned as field errors.
 */

export const AutomationKind = z.enum(['visitor', 'conversation']);
export type AutomationKind = z.infer<typeof AutomationKind>;

export const AutomationEventType = z.enum([
  'page_view',
  'chat_started',
  'customer_waiting',
  'chat_closed',
  'offline_message',
]);
export type AutomationEventType = z.infer<typeof AutomationEventType>;

export const AutomationTrigger = z
  .object({
    type: AutomationEventType,
    /** page_view: seconds on the page (0–600); customer_waiting: seconds without a reply (30–3600). */
    seconds: z.int().min(0).max(3600).default(0),
  })
  .meta({ id: 'AutomationTrigger' });

const TextValue = z.string().trim().min(1).max(200);
const Choices = z.array(z.string().trim().min(1).max(64)).min(1).max(50);

export const AutomationCondition = z
  .discriminatedUnion('field', [
    z.object({
      field: z.enum(['page_url', 'referrer']),
      op: z.enum(['contains', 'starts_with', 'is', 'not_contains']),
      value: TextValue,
    }),
    z.object({
      field: z.literal('visit_count'),
      op: z.enum(['at_least', 'at_most']),
      value: z.int().min(1).max(1000),
    }),
    z.object({
      field: z.enum(['country', 'device', 'language', 'owner', 'tag', 'team']),
      op: z.enum(['is', 'is_not']),
      value: Choices,
    }),
    z.object({
      field: z.enum(['hours_open', 'anyone_online', 'signed_in']),
      op: z.literal('is'),
      value: z.boolean(),
    }),
  ])
  .meta({ id: 'AutomationCondition' });
export type AutomationCondition = z.infer<typeof AutomationCondition>;

export const AutomationAction = z
  .discriminatedUnion('type', [
    /** Website rules: the words next to the launcher; choosing them opens the chat. */
    z.object({ type: z.literal('show_prompt'), message: LocalizedText(160) }),
    /** Said to the customer as the brand, in their language (never while the AI has the chat). */
    z.object({ type: z.literal('send_message'), message: LocalizedText(1000) }),
    /** A private note for staff. */
    z.object({ type: z.literal('add_note'), text: z.string().trim().min(1).max(2000) }),
    /** One of the brand's tags. */
    z.object({ type: z.literal('add_tag'), tag: z.string().trim().min(1).max(255) }),
    z.object({ type: z.literal('set_priority'), priority: TicketPriority }),
    /** A support team of the brand (team_…). */
    z.object({ type: z.literal('assign_team'), teamId: z.string().min(1).max(64) }),
    z.object({ type: z.literal('make_ticket') }),
  ])
  .meta({ id: 'AutomationAction' });
export type AutomationAction = z.infer<typeof AutomationAction>;

export const AutomationDefinition = z
  .object({
    event: AutomationTrigger,
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(AutomationCondition).max(10).default([]),
    actions: z.array(AutomationAction).min(1).max(5),
  })
  .meta({ id: 'AutomationDefinition' });
export type AutomationDefinition = z.infer<typeof AutomationDefinition>;

const AutomationName = z.string().trim().min(1).max(80);

export const AutomationVersionSummary = z
  .object({
    version: z.int().positive(),
    publishedAt: Timestamp,
    /** Who published it (staff_…), or null when Hamnivo did (moved from the old prompts). */
    publishedBy: z.string().nullable(),
    publishedByName: z.string().nullable(),
  })
  .meta({ id: 'AutomationVersionSummary' });
export type AutomationVersionSummary = z.infer<typeof AutomationVersionSummary>;

export const Automation = z
  .object({
    id: z.string(),
    brandId: z.string(),
    name: AutomationName,
    kind: AutomationKind,
    /** On and published: it runs. Off: kept, but never runs. */
    enabled: z.boolean(),
    /** What the editor shows; it runs only once published. */
    draft: AutomationDefinition,
    /** Changes each time the draft is saved; publishing names the draft it means. */
    revision: z.int().positive(),
    published: AutomationVersionSummary.extend({ definition: AutomationDefinition }).nullable(),
    /** The draft differs from what runs. */
    unpublishedChanges: z.boolean(),
    stats: z.object({
      /** Runs in the last 7 days (chat rules; website prompts run in visitors' browsers). */
      runsThisWeek: z.int().nonnegative(),
      lastRunAt: Timestamp.nullable(),
    }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'Automation' });
export type Automation = z.infer<typeof Automation>;

export const AutomationList = z
  .object({
    brandId: z.string(),
    items: z.array(Automation),
    /** Website prompts' limits for the brand (one visitor, one day). */
    promptLimits: z.object({
      maxPerDay: z.int().min(1).max(3),
      dismissHours: z.int().min(1).max(168),
    }),
  })
  .meta({ id: 'AutomationList' });
export type AutomationList = z.infer<typeof AutomationList>;

/** At most this many rules per brand. */
export const MAX_AUTOMATIONS_PER_BRAND = 50;

export const CreateAutomationRequest = z
  .object({
    name: AutomationName,
    definition: AutomationDefinition,
    /** Publish at once (a template used as it is). */
    publish: z.boolean().default(false),
  })
  .meta({ id: 'CreateAutomationRequest' });

export const SaveAutomationRequest = z
  .object({
    name: AutomationName,
    definition: AutomationDefinition,
    /** The revision the editor started from; another save since then is a conflict. */
    revision: z.int().positive(),
  })
  .meta({ id: 'SaveAutomationRequest' });

export const PublishAutomationRequest = z
  .object({ revision: z.int().positive() })
  .meta({ id: 'PublishAutomationRequest' });

export const SetAutomationEnabledRequest = z
  .object({ enabled: z.boolean() })
  .meta({ id: 'SetAutomationEnabledRequest' });

export const AutomationVersion = AutomationVersionSummary.extend({
  definition: AutomationDefinition,
  name: AutomationName,
}).meta({ id: 'AutomationVersion' });
export type AutomationVersion = z.infer<typeof AutomationVersion>;

export const AutomationVersionList = z
  .object({ items: z.array(AutomationVersion) })
  .meta({ id: 'AutomationVersionList' });
export type AutomationVersionList = z.infer<typeof AutomationVersionList>;

export const AutomationRunOutcome = z.enum(['done', 'skipped', 'failed']);
export type AutomationRunOutcome = z.infer<typeof AutomationRunOutcome>;

export const AutomationRun = z
  .object({
    id: z.string(),
    version: z.int().positive(),
    conversationId: z.string().nullable(),
    event: AutomationEventType,
    outcome: AutomationRunOutcome,
    /** Why it was skipped or failed, in a word: `no_match`, `someone_replied`, `ai_has_chat`, … */
    reason: z.string().nullable(),
    /** The actions that ran, by type. */
    actions: z.array(z.string()),
    ranAt: Timestamp,
  })
  .meta({ id: 'AutomationRun' });
export type AutomationRun = z.infer<typeof AutomationRun>;

export const AutomationRunList = z
  .object({ items: z.array(AutomationRun) })
  .meta({ id: 'AutomationRunList' });
export type AutomationRunList = z.infer<typeof AutomationRunList>;

export const UpdatePromptLimitsRequest = z
  .object({
    maxPerDay: z.int().min(1).max(3),
    dismissHours: z.int().min(1).max(168),
  })
  .meta({ id: 'UpdatePromptLimitsRequest' });

/** What the editor can choose from: the brand's tags and support teams. */
export const AutomationOptions = z
  .object({
    /** The chat account's tags, lower case; null when it could not be reached or is not set up. */
    tags: z.array(z.string()).nullable(),
    teams: z.array(z.object({ id: z.string(), name: z.string() })),
  })
  .meta({ id: 'AutomationOptions' });
export type AutomationOptions = z.infer<typeof AutomationOptions>;
