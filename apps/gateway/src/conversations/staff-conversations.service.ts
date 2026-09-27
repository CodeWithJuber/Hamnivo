import { createHash } from 'node:crypto';
import type { StaffConversation, StaffMessageRequest } from '@hamnivo/contracts';
import { type Db, fromPublicId, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import { OutboundMessagesService } from '../authority/outbound.service.js';
import {
  type ControlRow,
  OwnershipService,
  type OwnerTarget,
} from '../authority/ownership.service.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { StaffLinksService } from '../authority/staff-links.service.js';
import { customerView } from '../authority/views.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

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

/** Staff actions on a conversation (H08 takeover, H06 replies and notes) under their own identity. */
@Injectable()
export class StaffConversationsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ownership: OwnershipService,
    private readonly journal: JournalService,
    private readonly outbound: OutboundMessagesService,
    private readonly registry: AuthorityRegistry,
    private readonly staffLinks: StaffLinksService,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  /** Loads the conversation and checks the permission against its workspace, brand and inbox. */
  private async authorized(
    tx: TenantTx,
    principal: StaffPrincipal,
    publicId: string,
    permission: Permission,
  ): Promise<ControlRow> {
    const [control] = await tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, fromPublicId('conversation', publicId)));
    if (!control) throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    const [brand] = control.brandId
      ? await tx
          .select({ workspaceId: schema.brands.workspaceId })
          .from(schema.brands)
          .where(eq(schema.brands.id, control.brandId))
      : [];
    const decision = authorize(
      principal,
      permission,
      {
        ...(brand ? { workspaceId: brand.workspaceId } : {}),
        ...(control.brandId ? { brandId: control.brandId } : {}),
        inboxId: control.inboxId,
      },
      { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
    );
    if (
      !decision.allowed &&
      decision.reason !== 'mfa_required' &&
      decision.reason !== 'step_up_required'
    ) {
      // Outside the caller's scope the conversation does not exist for them.
      throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    }
    enforce(decision);
    return control;
  }

  get(principal: StaffPrincipal, publicId: string): Promise<StaffConversation> {
    return this.tx(principal, async (tx) =>
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
    const outcome = await this.tx(principal, async (tx) => {
      const control = await this.authorized(tx, principal, publicId, permission);
      const result = await this.ownership.transition(
        tx,
        principal.tenantId,
        control.id,
        await target(tx, control),
        {
          origin: 'hamnivo',
          reason,
          actor: { type: 'staff', id: toPublicId('staff', principal.staffMemberId) },
          ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
        },
      );
      return result;
    });
    await this.journal.notify(principal.tenantId, outcome.control.id, outcome.journal);
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

  /** Replies publicly (taking over first when needed) or writes an internal note, as yourself. */
  async send(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof StaffMessageRequest>,
  ) {
    const internal = input.visibility === 'internal';
    const permission: Permission = internal ? 'conversations.note' : 'conversations.reply';
    const control = await this.tx(principal, (tx) =>
      this.authorized(tx, principal, publicId, permission),
    );
    if (
      !internal &&
      !(control.ownerMode === 'HUMAN_ACTIVE' && control.ownerStaffId === principal.staffMemberId)
    ) {
      // A public human reply takes the conversation over, so the AI cannot answer in parallel.
      await this.change(
        principal,
        publicId,
        'conversations.takeover',
        async () => ({ kind: 'staff', staffMemberId: principal.staffMemberId }),
        'staff_reply',
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
      requestHash: createHash('sha256')
        .update(canonicalize({ text: input.text, visibility: input.visibility }) ?? '')
        .digest(),
      author: { kind: 'staff', userRef: String(externalUserId) },
      visibility: internal ? 'private' : 'public',
      text: input.text,
      load: (tx) => this.authorized(tx, principal, publicId, permission),
    });
    return { messageId: result.message.id, status: result.status };
  }
}
