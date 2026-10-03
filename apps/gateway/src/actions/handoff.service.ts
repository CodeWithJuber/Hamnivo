import type { HandoffPacket as HandoffPacketView } from '@hamnivo/contracts';
import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import {
  boundedPacket,
  type HandoffAttempt,
  type HandoffFact,
  type HandoffPacket,
  type HandoffPending,
  renderHandoffNote,
} from '@hamnivo/domain/actions';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { ControlRow } from '../authority/ownership.service.js';
import { InboxAccess } from '../inbox/access.js';

const TOOL_OUTCOMES: Record<string, string> = {
  executed: 'done',
  approval: 'waiting for approval',
  deny: 'refused',
  invalid: 'the request was incomplete',
  fenced: 'stopped: someone else took the conversation',
};

const GUARDS: Record<string, string> = {
  honest_identity: 'Honesty check on the reply',
  receipt_claims: 'Receipt check on a payment or refund claim',
  action_claims: 'Receipt check on an action claim',
};

/**
 * Handoff packets (G10, HNV-10-03): when the AI hands a conversation to people, a structured
 * packet built only from Hamnivo's records says why, what the AI did (its run steps), what is still
 * pending (actions and approvals) and the customer facts it relied on, each with its source. It is
 * stored (append-only) and posted as the private handoff note.
 */
@Injectable()
export class HandoffPackets {
  constructor(private readonly access: InboxAccess) {}

  private async attempts(tx: TenantTx, runId: string | null): Promise<HandoffAttempt[]> {
    if (!runId) return [];
    const steps = await tx
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId))
      .orderBy(asc(schema.runSteps.seq));
    const attempts: HandoffAttempt[] = [];
    for (const step of steps) {
      const detail = (step.detail ?? {}) as Record<string, unknown>;
      switch (step.kind) {
        case 'retrieval':
          attempts.push({
            kind: 'knowledge',
            label: 'Searched the knowledge base',
            outcome: `${Number(detail.passages ?? 0)} passages found`,
          });
          break;
        case 'tool': {
          const decision = String(detail.decision ?? '');
          const outcome = typeof detail.outcome === 'string' ? detail.outcome : null;
          attempts.push({
            kind: 'tool',
            label: `Tool: ${step.name}`,
            outcome: outcome ?? TOOL_OUTCOMES[decision] ?? decision,
          });
          break;
        }
        case 'guard':
          if (step.status === 'blocked') {
            attempts.push({
              kind: 'guard',
              label: GUARDS[step.name] ?? step.name,
              outcome: 'held the reply back',
            });
          }
          break;
        case 'model':
          if (step.status === 'error') {
            attempts.push({
              kind: 'model',
              label: 'AI model',
              outcome: `unavailable (${String(detail.errorKind ?? 'error')})`,
            });
          }
          break;
        case 'decision':
          if (step.name === 'human_request') {
            attempts.push({
              kind: 'decision',
              label: 'Customer request',
              outcome: 'asked for a person',
            });
          }
          break;
      }
    }
    return attempts;
  }

  /** The packet for a handoff that is about to happen (pending approvals end with it). */
  async build(
    tx: TenantTx,
    input: {
      control: ControlRow;
      runId: string | null;
      reason: string;
      reasonText: string;
      request: string | null;
      replyLanguage: string | null;
    },
  ): Promise<HandoffPacket> {
    const actions = await tx
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.conversationId, input.control.id))
      .orderBy(desc(schema.actions.createdAt))
      .limit(30);
    const pending: HandoffPending[] = actions
      .filter((a) => ['awaiting_approval', 'approved', 'executing', 'unknown'].includes(a.state))
      .map((a) => ({
        actionId: toPublicId('action', a.id),
        title: a.summary,
        // Approvals are bound to the ownership epoch: this handoff supersedes the unsent ones.
        state:
          a.state === 'awaiting_approval' || a.state === 'approved'
            ? ('superseded' as const)
            : (a.state as 'executing' | 'unknown'),
        approver: a.approver,
        expiresAt: a.expiresAt?.toISOString() ?? null,
      }));
    const facts: HandoffFact[] = actions
      .filter((a) => a.state === 'completed' && a.outcomeSummary)
      .slice(0, 6)
      .map((a) => ({
        label: a.toolTitle,
        value: a.outcomeSummary as string,
        source: {
          kind: 'tool' as const,
          ref: toPublicId('action', a.id),
          observedAt: (a.completedAt ?? a.updatedAt).toISOString(),
        },
      }));
    if (input.control.principalId) {
      const [principal] = await tx
        .select({
          kind: schema.customerPrincipals.kind,
          seen: schema.customerPrincipals.lastSeenAt,
        })
        .from(schema.customerPrincipals)
        .where(eq(schema.customerPrincipals.id, input.control.principalId));
      if (principal?.kind === 'verified') {
        facts.push({
          label: 'Identity',
          value: 'Signed in on the website (verified by the business)',
          source: {
            kind: 'identity',
            ref: toPublicId('customer', input.control.principalId),
            observedAt: principal.seen?.toISOString() ?? null,
          },
        });
      }
    }
    if (input.replyLanguage) {
      facts.push({
        label: 'Reply language',
        value: input.replyLanguage,
        source: { kind: 'language', ref: null, observedAt: null },
      });
    }
    return boundedPacket({
      version: 1,
      reason: input.reason,
      reasonText: input.reasonText,
      request: input.request,
      replyLanguage: input.replyLanguage,
      attempts: await this.attempts(tx, input.runId),
      pending,
      facts,
    });
  }

  /** Stores the packet for the new epoch; the same handoff recorded twice keeps the first. */
  async record(
    tx: TenantTx,
    input: { tenantId: string; conversationId: string; epoch: number; runId: string | null },
    packet: HandoffPacket,
  ): Promise<void> {
    await tx
      .insert(schema.handoffPackets)
      .values({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        epoch: input.epoch,
        runId: input.runId,
        reason: packet.reason,
        packet: packet as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing();
  }

  note(packet: HandoffPacket): string {
    return renderHandoffNote(packet);
  }

  async list(principal: StaffPrincipal, conversationId: string): Promise<HandoffPacketView[]> {
    return this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(
        tx,
        principal,
        conversationId,
        'conversations.read',
      );
      const rows = await tx
        .select()
        .from(schema.handoffPackets)
        .where(and(eq(schema.handoffPackets.conversationId, found.control.id)))
        .orderBy(desc(schema.handoffPackets.epoch))
        .limit(10);
      return rows.map((row) => {
        const packet = row.packet as unknown as HandoffPacket;
        return {
          id: toPublicId('handoff', row.id),
          conversationId,
          epoch: row.epoch,
          reason: packet.reason,
          reasonText: packet.reasonText,
          request: packet.request,
          replyLanguage: packet.replyLanguage,
          attempts: packet.attempts,
          pending: packet.pending,
          facts: packet.facts,
          createdAt: row.createdAt.toISOString(),
        };
      });
    });
  }
}
