import { createHash } from 'node:crypto';
import type { ErrorCode, StaffConversation, StaffMessageRequest } from '@hamnivo/contracts';
import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { Permission, StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { assertReplyWindow } from '../authority/channel-window.js';
import { JournalService } from '../authority/journal.service.js';
import { OutboundMessagesService } from '../authority/outbound.service.js';
import {
  type ControlRow,
  currentOwnerOf,
  OwnershipService,
  type OwnerTarget,
} from '../authority/ownership.service.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { StaffLinksService } from '../authority/staff-links.service.js';
import { customerView } from '../authority/views.js';
import { AppError } from '../common/app-error.js';
import { InboxAccess } from '../inbox/access.js';
import { DraftsService } from '../inbox/drafts.service.js';
import { CLOCK, type Clock } from '../tokens.js';
import { type PreparedTemplate, WhatsappTemplatesService } from './whatsapp-templates.service.js';

function staffView(control: ControlRow): StaffConversation {
  const view = customerView(control.ownerMode, control.authorityStatus);
  let owner: StaffConversation['owner'] = { kind: 'none' };
  if (control.ownerMode === 'AI_ACTIVE') owner = { kind: 'ai' };
  else if (control.ownerMode === 'HUMAN_ACTIVE') {
    owner = control.ownerStaffId
      ? { kind: 'staff', staffMemberId: toPublicId('staff', control.ownerStaffId) }
      : {
          kind: 'external',
          displayName: `Chatwoot user ${control.ownerExternalUserId ?? ''}`.trim(),
        };
  }
  return {
    id: toPublicId('conversation', control.id),
    brandId: control.brandId ? toPublicId('brand', control.brandId) : null,
    ownerMode: control.ownerMode,
    ownershipEpoch: control.ownershipEpoch,
    owner,
    customerStatus: view.status,
    authorityStatus: control.authorityStatus,
    lastActivityAt: control.lastActivityAt.toISOString(),
  };
}

/** Another person (a colleague, or someone in Chatwoot's own interface) owns the conversation. */
export function ownedByOther(control: ControlRow, staffMemberId: string): boolean {
  return control.ownerMode === 'HUMAN_ACTIVE' && control.ownerStaffId !== staffMemberId;
}

/** Errors worth keeping a failed send for: the text is kept for a later retry. */
const KEPT: ReadonlySet<ErrorCode> = new Set([
  'AUTHORITY_UNAVAILABLE',
  'OWNERSHIP_CHANGED',
  'INTERNAL',
  'RATE_LIMITED',
]);

/** Staff actions on a conversation (H08 takeover, H03 notes, replies) under their own identity. */
@Injectable()
export class StaffConversationsService {
  constructor(
    private readonly access: InboxAccess,
    private readonly ownership: OwnershipService,
    private readonly journal: JournalService,
    private readonly outbound: OutboundMessagesService,
    private readonly registry: AuthorityRegistry,
    private readonly staffLinks: StaffLinksService,
    private readonly drafts: DraftsService,
    private readonly templates: WhatsappTemplatesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Loads the conversation and checks the permission against its workspace, brand, inbox and team. */
  private async authorized(
    tx: TenantTx,
    principal: StaffPrincipal,
    publicId: string,
    permission: Permission,
  ): Promise<ControlRow> {
    return (await this.access.authorized(tx, principal, publicId, permission)).control;
  }

  get(principal: StaffPrincipal, publicId: string): Promise<StaffConversation> {
    return this.access.tx(principal, async (tx) =>
      staffView(await this.authorized(tx, principal, publicId, 'conversations.read')),
    );
  }

  private async change(
    principal: StaffPrincipal,
    publicId: string,
    permission: Permission,
    target: (tx: TenantTx, control: ControlRow) => Promise<OwnerTarget>,
    reason: 'staff_takeover' | 'return_to_ai' | 'staff_reply',
    expectedEpoch?: number,
  ): Promise<StaffConversation> {
    const outcome = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, permission);
      // Taking a conversation from a colleague is a supervisor's call (H14): others ask for it.
      if (reason === 'staff_takeover' && ownedByOther(found.control, principal.staffMemberId)) {
        const decision = this.access.decide(principal, 'conversations.assign', found.resource);
        if (!decision.allowed) {
          throw new AppError('OWNERSHIP_CHANGED', {
            detail:
              'A colleague is handling this conversation. Ask them to hand it over, or ask a supervisor.',
            currentOwner: await currentOwnerOf(tx, found.control),
          });
        }
      }
      return this.ownership.transition(
        tx,
        principal.tenantId,
        found.control.id,
        await target(tx, found.control),
        {
          origin: 'hamnivo',
          reason,
          actor: { type: 'staff', id: toPublicId('staff', principal.staffMemberId) },
          actorStaffMemberId: principal.staffMemberId,
          ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
        },
      );
    });
    await this.journal.notify(principal.tenantId, outcome.control.id, outcome.journal);
    if (outcome.changed && outcome.journal.length === 0) {
      await this.journal.signalInbox(principal.tenantId, outcome.control.id);
    }
    return staffView(outcome.control);
  }

  takeover(
    principal: StaffPrincipal,
    publicId: string,
    expectedEpoch?: number,
  ): Promise<StaffConversation> {
    return this.change(
      principal,
      publicId,
      'conversations.takeover',
      async () => ({ kind: 'staff', staffMemberId: principal.staffMemberId }),
      'staff_takeover',
      expectedEpoch,
    );
  }

  returnToAi(
    principal: StaffPrincipal,
    publicId: string,
    expectedEpoch?: number,
  ): Promise<StaffConversation> {
    return this.change(
      principal,
      publicId,
      'conversations.assign',
      async (tx, control) => {
        const [bot] = await tx
          .select({ id: schema.authorityBots.id })
          .from(schema.authorityBots)
          .where(
            and(
              eq(schema.authorityBots.connectionId, control.connectionId),
              eq(schema.authorityBots.role, 'primary'),
              eq(schema.authorityBots.status, 'active'),
            ),
          );
        if (!bot)
          throw new AppError('FEATURE_DISABLED', {
            detail: 'No AI assistant is attached to this inbox.',
          });
        return { kind: 'ai', botId: bot.id };
      },
      'return_to_ai',
      expectedEpoch,
    );
  }

  /**
   * Replies publicly (taking over first when the AI or the queue has it) or writes an internal
   * note, as yourself. A public reply is refused when a colleague owns the conversation, or when
   * the owner changed after the sender's view (`expectedEpoch`): a stale reply is never sent.
   */
  async send(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof StaffMessageRequest>,
    /** `keepFailed`: keep every failure to retry, refusals too (an approved AI draft, HNV-09-05). */
    options: { keepFailed?: boolean } = {},
  ) {
    const internal = input.visibility === 'internal';
    const permission: Permission = internal ? 'conversations.note' : 'conversations.reply';
    const lane = internal ? 'internal' : 'public';
    // A WhatsApp template (D14) is checked against Chatwoot's list first; its text is rendered.
    const prepared: PreparedTemplate | null = input.template
      ? await this.templates.prepare(principal, publicId, input.template)
      : null;
    const text = prepared?.text ?? input.text ?? '';
    const control = await this.access.tx(principal, async (tx) => {
      const control = await this.authorized(tx, principal, publicId, permission);
      if (!internal) {
        if (input.expectedEpoch !== undefined && input.expectedEpoch !== control.ownershipEpoch) {
          throw new AppError('OWNERSHIP_CHANGED', {
            detail: 'Someone else changed who handles this conversation. Nothing was sent.',
            currentOwner: await currentOwnerOf(tx, control),
          });
        }
        if (ownedByOther(control, principal.staffMemberId)) {
          throw new AppError('OWNERSHIP_CHANGED', {
            detail:
              'A colleague is handling this conversation. Take it over first. Nothing was sent.',
            currentOwner: await currentOwnerOf(tx, control),
          });
        }
        // A template is what WhatsApp allows once the 24-hour window has closed.
        if (!prepared) await assertReplyWindow(tx, control, this.clock());
      }
      await this.drafts.startOutgoing(tx, {
        tenantId: principal.tenantId,
        conversationId: control.id,
        staffMemberId: principal.staffMemberId,
        lane,
        clientMessageId: input.clientMessageId,
        text,
        clearDraft: input.clearDraft,
      });
      return control;
    });
    try {
      if (
        !internal &&
        !(control.ownerMode === 'HUMAN_ACTIVE' && control.ownerStaffId === principal.staffMemberId)
      ) {
        // A public human reply takes the conversation over, so the AI cannot answer in parallel.
        // The epoch seen above makes a claim by someone else in the meantime refuse this reply.
        await this.change(
          principal,
          publicId,
          'conversations.takeover',
          async () => ({ kind: 'staff', staffMemberId: principal.staffMemberId }),
          'staff_reply',
          control.ownershipEpoch,
        );
      }
      const runtime = await this.registry.get(principal.tenantId, control.connectionId);
      const externalUserId = await this.staffLinks.ensure(runtime, principal.staffMemberId);
      const result = await this.outbound.send({
        tenantId: principal.tenantId,
        actorId: toPublicId('staff', principal.staffMemberId),
        conversationId: control.id,
        sender: { kind: 'staff', id: principal.staffMemberId },
        clientMessageId: input.clientMessageId,
        // A retry with another template or other values is a different message (IDEMPOTENCY_CONFLICT).
        requestHash: createHash('sha256')
          .update(
            canonicalize(
              input.template
                ? { template: input.template, visibility: input.visibility }
                : { text: input.text, visibility: input.visibility },
            ) ?? '',
          )
          .digest(),
        author: { kind: 'staff', userRef: String(externalUserId) },
        visibility: internal ? 'private' : 'public',
        text,
        ...(prepared ? { template: prepared.template } : {}),
        load: (tx) => this.authorized(tx, principal, publicId, permission),
        ...(input.suggestionId || prepared
          ? {
              onCommitted: async (tx: TenantTx) => {
                // A reply that started from an AI suggestion is still the person's own; the
                // audit says so.
                if (input.suggestionId) {
                  await appendAudit(tx, {
                    actorType: 'staff',
                    actorId: toPublicId('staff', principal.staffMemberId),
                    action: 'conversation.copilot_reply_sent',
                    targetType: 'conversation',
                    targetId: publicId,
                    outcome: 'success',
                    data: { suggestionId: input.suggestionId, visibility: input.visibility },
                  });
                }
                if (prepared) {
                  await appendAudit(tx, {
                    actorType: 'staff',
                    actorId: toPublicId('staff', principal.staffMemberId),
                    action: 'conversation.template_sent',
                    targetType: 'conversation',
                    targetId: publicId,
                    outcome: 'success',
                    data: {
                      template: prepared.template.name,
                      language: prepared.template.language,
                      category: prepared.template.category,
                    },
                  });
                }
              },
            }
          : {}),
      });
      await this.drafts.finishOutgoing(principal, control.id, input.clientMessageId);
      return { messageId: result.message.id, status: result.status };
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'INTERNAL';
      // A failed template is not kept to retry as text: the picker resends it, with the same id.
      if ((KEPT.has(code) || options.keepFailed) && !prepared) {
        await this.drafts
          .failOutgoing(principal, control.id, input.clientMessageId, code)
          .catch(() => undefined);
      } else {
        await this.drafts
          .finishOutgoing(principal, control.id, input.clientMessageId)
          .catch(() => undefined);
      }
      throw error;
    }
  }
}
