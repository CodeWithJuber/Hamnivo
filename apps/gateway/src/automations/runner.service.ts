import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { type ActorCredential, type AuthorityMessage, isOpen } from '@hamnivo/domain';
import {
  type AutomationFacts,
  type ChatOwner,
  DEVICES,
  type Device,
  evaluate,
  MAX_AUTOMATED_MESSAGES_PER_DAY,
} from '@hamnivo/domain/automations';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, arrayContains, count, desc, eq, gte } from 'drizzle-orm';
import { OwnershipService } from '../authority/ownership.service.js';
import { AuthorityRegistry, type ConnectionRuntime } from '../authority/registry.js';
import { uuidV5 } from '../authority/uuid.js';
import { AvailabilityService } from '../inbox/availability.service.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { makeTicket } from '../tickets/tickets.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { asksAnyoneOnline, type PublishedAutomation, publishedAutomations } from './definitions.js';
import { AUTOMATION_TOPIC, type AutomationEventPayload } from './events.js';

type ControlRow = typeof schema.conversationControls.$inferSelect;
/** A conversation Hamnivo started for one of a brand's customers. */
type Chat = ControlRow & { brandId: string; principalId: string };
type Locale = 'en' | 'ar' | 'hi' | 'ur';

const INTEGRATION: ActorCredential = { kind: 'integration' };
const DAY_MS = 24 * 3_600_000;
const LOCALES: readonly Locale[] = ['en', 'ar', 'hi', 'ur'];

/** Whether a message the customer can see came from the team or a bot, not from them. */
const saidToCustomer = (message: AuthorityMessage) =>
  !message.private && (message.direction === 'outgoing' || message.direction === 'template');

const OWNERS: Record<ControlRow['ownerMode'], ChatOwner> = {
  AI_ACTIVE: 'ai',
  WAITING_HUMAN: 'waiting',
  HUMAN_ACTIVE: 'person',
  PAUSED: 'person',
};

/** `/pricing?plan=pro` from a stored page address; the address as it is when it does not parse. */
function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

const localeOf = (language: string | null | undefined): Locale => {
  const base = (language ?? '').toLowerCase().split('-')[0] as Locale;
  return LOCALES.includes(base) ? base : 'en';
};

/**
 * Runs the brand's chat automations (G21) from the outbox topic `automation.event`. For each
 * published rule of the event it gathers the facts, checks the conditions and runs the actions
 * through the paths staff use. Safe to repeat:
 * - a rule acts at most once per conversation and event (`automation_runs`);
 * - each action is idempotent (keys for the message and the note, sets for tags, team, priority
 *   and ticket);
 * - a "waiting" rule checks, when it is due, that nobody has said anything to the customer since
 *   their message;
 * - a message is never sent while the AI has the chat (read again under the conversation's lock),
 *   and at most five automated messages reach a conversation in a day.
 * Messages from automations are not customer messages, so they never start another automation.
 */
@Injectable()
export class AutomationRunner {
  private readonly logger = new Logger(AutomationRunner.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
    private readonly ownership: OwnershipService,
    private readonly availability: AvailabilityService,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'automation' }, work);
  }

  async onEvent(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as AutomationEventPayload;
    const tenantId = event.tenantId;
    const loaded = await this.tx(tenantId, async (tx) => {
      const [control] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId));
      // Imported conversations have no brand or customer here, and no rules run on them.
      if (!control?.brandId || !control.principalId) return null;
      const rules = await publishedAutomations(tx, control.brandId, 'conversation');
      return { control: control as Chat, rules };
    });
    if (!loaded) return;
    const { control } = loaded;
    if (payload.event === 'customer_message') {
      await this.scheduleWaiting(tenantId, control, loaded.rules, payload);
      return;
    }
    const rules = loaded.rules.filter(
      (rule) =>
        rule.definition.event.type === payload.event &&
        (payload.event !== 'customer_waiting' || rule.id === payload.automationId),
    );
    if (rules.length === 0) return;
    if (payload.event === 'customer_waiting') {
      // Over once the chat closed or anyone said something to the customer since their message.
      if (control.authorityStatus === 'resolved') return;
      if (await this.repliedSince(tenantId, control, payload.afterMessage)) return;
    }
    const facts = await this.facts(tenantId, control, rules);
    for (const rule of rules) {
      await this.run(tenantId, control, rule, payload.event, facts);
    }
  }

  /** Each customer message starts the clock again for every "waiting for a reply" rule. */
  private async scheduleWaiting(
    tenantId: string,
    control: Chat,
    rules: PublishedAutomation[],
    payload: Extract<AutomationEventPayload, { event: 'customer_message' }>,
  ): Promise<void> {
    const waiting = rules.filter((rule) => rule.definition.event.type === 'customer_waiting');
    if (waiting.length === 0) return;
    await this.tx(tenantId, async (tx) => {
      const [ledger] = await tx
        .select({ authorityMessageId: schema.messageLedger.authorityMessageId })
        .from(schema.messageLedger)
        .where(eq(schema.messageLedger.id, payload.ledgerId));
      if (!ledger?.authorityMessageId) return;
      const now = this.clock().getTime();
      for (const rule of waiting) {
        if (await this.ran(tx, rule.id, control.id, 'customer_waiting')) continue;
        const due: AutomationEventPayload = {
          conversationId: control.id,
          event: 'customer_waiting',
          ref: payload.ref,
          automationId: rule.id,
          afterMessage: ledger.authorityMessageId,
        };
        await enqueueOutbox(tx, tenantId, {
          topic: AUTOMATION_TOPIC,
          aggregateType: 'conversation',
          aggregateId: control.id,
          payload: { ...due },
          availableAt: new Date(now + rule.definition.event.seconds * 1000),
        });
      }
    });
  }

  private async ran(
    tx: TenantTx,
    automationId: string,
    conversationId: string,
    eventKey: string,
  ): Promise<boolean> {
    const [found] = await tx
      .select({ id: schema.automationRuns.id })
      .from(schema.automationRuns)
      .where(
        and(
          eq(schema.automationRuns.automationId, automationId),
          eq(schema.automationRuns.conversationId, conversationId),
          eq(schema.automationRuns.eventKey, eventKey),
        ),
      );
    return found !== undefined;
  }

  private async repliedSince(
    tenantId: string,
    control: Chat,
    afterMessage: number,
  ): Promise<boolean> {
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const later = await runtime.authority.listMessages(String(control.externalConversationId), {
      view: 'staff',
      after: String(afterMessage),
    });
    return later.some(saidToCustomer);
  }

  /** What is known about the conversation now: the visitor's latest visit, the chat and the team. */
  private async facts(
    tenantId: string,
    control: Chat,
    rules: PublishedAutomation[],
  ): Promise<AutomationFacts> {
    return this.tx(tenantId, async (tx) => {
      const [brand] = await tx
        .select()
        .from(schema.brands)
        .where(eq(schema.brands.id, control.brandId));
      const [principal] = await tx
        .select({ kind: schema.customerPrincipals.kind, locale: schema.customerPrincipals.locale })
        .from(schema.customerPrincipals)
        .where(eq(schema.customerPrincipals.id, control.principalId));
      const [visit] = await tx
        .select({ session: schema.visitorSessions, visits: schema.visitors.visitCount })
        .from(schema.visitors)
        .innerJoin(schema.visitorSessions, eq(schema.visitorSessions.visitorId, schema.visitors.id))
        .where(eq(schema.visitors.principalId, control.principalId))
        .orderBy(desc(schema.visitorSessions.lastSeenAt))
        .limit(1);
      const [state] = await tx
        .select({
          labels: schema.conversationInboxState.labels,
          teamId: schema.conversationInboxState.teamId,
        })
        .from(schema.conversationInboxState)
        .where(eq(schema.conversationInboxState.conversationId, control.id));
      const device = visit?.session.deviceType;
      const anyoneOnline =
        brand && asksAnyoneOnline(rules)
          ? await this.availability.anyOnline(tx, tenantId, {
              workspaceId: brand.workspaceId,
              brandId: brand.id,
            })
          : null;
      return {
        page_url: pathOf(visit?.session.currentUrl ?? null),
        referrer: visit?.session.referrer ?? null,
        visit_count: visit?.visits ?? null,
        country: visit?.session.country ?? null,
        device:
          device && (DEVICES as readonly string[]).includes(device) ? (device as Device) : null,
        language: principal?.locale ?? visit?.session.language ?? null,
        signed_in: principal ? principal.kind === 'verified' : null,
        hours_open: brand?.businessHours ? isOpen(brand.businessHours, this.clock()) : null,
        anyone_online: anyoneOnline,
        owner: OWNERS[control.ownerMode],
        tag: state?.labels ?? [],
        team: state?.teamId ? toPublicId('team', state.teamId) : null,
      };
    });
  }

  private async run(
    tenantId: string,
    control: Chat,
    rule: PublishedAutomation,
    event: Exclude<AutomationEventPayload['event'], 'customer_message'>,
    facts: AutomationFacts,
  ): Promise<void> {
    const ref = String(control.externalConversationId);
    const decided = await this.tx(tenantId, async (tx) => {
      if (await this.ran(tx, rule.id, control.id, event)) return null;
      if (!evaluate(rule.definition, facts).matched) return null;
      const actions = rule.definition.actions;
      if (!actions.some((action) => action.type === 'send_message')) {
        return { actions, dropped: null as string | null, language: null as string | null };
      }
      // A message: read who has the chat again under its lock, and keep to the daily limit.
      const locked = await this.ownership.lock(tx, control.id);
      const [sent] = await tx
        .select({ n: count() })
        .from(schema.automationRuns)
        .where(
          and(
            eq(schema.automationRuns.conversationId, control.id),
            eq(schema.automationRuns.outcome, 'done'),
            arrayContains(schema.automationRuns.actions, ['send_message']),
            gte(schema.automationRuns.ranAt, new Date(this.clock().getTime() - DAY_MS)),
          ),
        );
      const dropped =
        locked.ownerMode === 'AI_ACTIVE'
          ? 'ai_has_chat'
          : (sent?.n ?? 0) >= MAX_AUTOMATED_MESSAGES_PER_DAY
            ? 'message_limit'
            : null;
      return {
        actions: dropped ? actions.filter((action) => action.type !== 'send_message') : actions,
        dropped,
        language: facts.language ?? null,
      };
    });
    if (!decided) return;
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const key = (what: string) => uuidV5(control.id, `automation:${rule.id}:${event}:${what}`);
    let dropped = decided.dropped;
    const done: string[] = [];
    for (const action of decided.actions) {
      switch (action.type) {
        case 'send_message': {
          const bot = runtime.primaryBot;
          if (!bot) {
            dropped = 'no_bot';
            continue;
          }
          const messageKey = `hv1:a:${key('message')}`;
          if (!(await runtime.authority.findByKey(ref, messageKey))) {
            const text = action.message[localeOf(decided.language)] ?? action.message.en;
            await runtime.authority.appendMessage({
              conversationRef: ref,
              key: messageKey,
              author: { kind: 'bot', botRef: String(bot.externalBotId) },
              visibility: 'public',
              text,
              contentAttributes: { hv: { v: 1, automation: rule.publicId } },
            });
          }
          break;
        }
        case 'add_tag':
          await this.addTag(tenantId, runtime, control, action.tag);
          break;
        case 'set_priority':
          await runtime.authority.setPriority(ref, action.priority, INTEGRATION);
          await this.tx(tenantId, (tx) =>
            tx
              .insert(schema.conversationInboxState)
              .values({ tenantId, conversationId: control.id, priority: action.priority })
              .onConflictDoUpdate({
                target: [
                  schema.conversationInboxState.tenantId,
                  schema.conversationInboxState.conversationId,
                ],
                set: { priority: action.priority, updatedAt: this.clock() },
              }),
          );
          break;
        case 'add_note':
        case 'assign_team':
        case 'make_ticket':
        case 'show_prompt':
          // Recorded with the run below, in one transaction.
          break;
      }
      done.push(action.type);
    }
    await this.tx(tenantId, async (tx) => {
      for (const action of decided.actions) {
        if (action.type === 'add_note') {
          await enqueueOutbox(tx, tenantId, {
            topic: 'conversation.note',
            aggregateType: 'conversation',
            aggregateId: control.id,
            payload: {
              conversationId: control.id,
              key: `hv1:n:${key('note')}`,
              text: action.text,
            },
          });
        } else if (action.type === 'assign_team') {
          await this.assignTeam(tx, tenantId, control.id, action.teamId, rule);
        } else if (action.type === 'make_ticket') {
          const { number, created } = await makeTicket(
            tx,
            tenantId,
            control.id,
            'automation',
            this.clock(),
          );
          if (created) {
            await this.audit(tx, rule, control.id, 'conversation.ticket_made', {
              reference: `#${number}`,
              source: 'automation',
            });
          }
        }
      }
      const [recorded] = await tx
        .insert(schema.automationRuns)
        .values({
          tenantId,
          brandId: control.brandId,
          automationId: rule.id,
          versionId: rule.versionId,
          conversationId: control.id,
          event,
          eventKey: event,
          outcome: 'done',
          reason: dropped,
          actions: done,
          ranAt: this.clock(),
        })
        .onConflictDoNothing()
        .returning({ id: schema.automationRuns.id });
      if (recorded) {
        await this.audit(tx, rule, control.id, 'automation.ran', {
          version: rule.version,
          event,
          actions: done,
          ...(dropped ? { left_out: dropped } : {}),
        });
      }
    });
    this.logger.log(
      `automation ${rule.publicId} ran on conversation ${control.id} (${event}): ${done.join(', ')}${dropped ? `; message left out: ${dropped}` : ''}`,
    );
  }

  private async addTag(
    tenantId: string,
    runtime: ConnectionRuntime,
    control: Chat,
    tag: string,
  ): Promise<void> {
    const ref = String(control.externalConversationId);
    const { labels } = await runtime.authority.getState(ref, INTEGRATION);
    if (labels.some((label) => label.toLowerCase() === tag.toLowerCase())) return;
    const next = [...labels, tag.toLowerCase()];
    await runtime.authority.annotate(ref, { labels: next }, INTEGRATION);
    await this.tx(tenantId, (tx) =>
      tx
        .insert(schema.conversationInboxState)
        .values({ tenantId, conversationId: control.id, labels: next })
        .onConflictDoUpdate({
          target: [
            schema.conversationInboxState.tenantId,
            schema.conversationInboxState.conversationId,
          ],
          set: { labels: next, updatedAt: this.clock() },
        }),
    );
  }

  /** The team through the inbox's own path; a team that left the brand is skipped. */
  private async assignTeam(
    tx: TenantTx,
    tenantId: string,
    conversationId: string,
    teamPublicId: string,
    rule: PublishedAutomation,
  ): Promise<void> {
    let teamId: string | null = null;
    try {
      teamId = fromPublicId('team', teamPublicId);
    } catch {
      teamId = null;
    }
    const [team] = teamId
      ? await tx
          .select({ id: schema.teams.id })
          .from(schema.teams)
          .where(and(eq(schema.teams.id, teamId), eq(schema.teams.status, 'active')))
      : [];
    if (!team || !teamId) {
      this.logger.warn(`automation ${rule.publicId}: team ${teamPublicId} is no longer active`);
      return;
    }
    const [current] = await tx
      .select({ teamId: schema.conversationInboxState.teamId })
      .from(schema.conversationInboxState)
      .where(eq(schema.conversationInboxState.conversationId, conversationId));
    if (current?.teamId === teamId) return;
    await tx
      .insert(schema.conversationInboxState)
      .values({ tenantId, conversationId, teamId })
      .onConflictDoUpdate({
        target: [
          schema.conversationInboxState.tenantId,
          schema.conversationInboxState.conversationId,
        ],
        set: { teamId, updatedAt: this.clock() },
      });
    await enqueueOutbox(tx, tenantId, {
      topic: 'conversation.team_changed',
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { conversationId, teamId, actorStaffMemberId: null },
    });
    await this.audit(tx, rule, conversationId, 'conversation.routed', {
      from: current?.teamId ? toPublicId('team', current.teamId) : null,
      team: teamPublicId,
      source: 'automation',
    });
  }

  private async audit(
    tx: TenantTx,
    rule: PublishedAutomation,
    conversationId: string,
    action: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await appendAudit(tx, {
      actorType: 'system',
      actorId: rule.publicId,
      action,
      targetType: 'conversation',
      targetId: toPublicId('conversation', conversationId),
      outcome: 'success',
      data: { automation: rule.publicId, name: rule.name, ...data },
    });
  }
}
