import type { DraftLane, DraftsView, ErrorCode, StaffDraft } from '@hamnivo/contracts';
import { schema, type TenantTx } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { CLOCK, type Clock } from '../tokens.js';
import { InboxAccess } from './access.js';

const d = schema.staffDrafts;

const mine = (conversationId: string, staffMemberId: string) =>
  and(eq(d.conversationId, conversationId), eq(d.staffMemberId, staffMemberId));

/**
 * Drafts and failed sends (H09). A draft belongs to one person, conversation and lane, so a note
 * never becomes a public reply by switching modes. A send is recorded before it reaches the
 * authority and removed once confirmed; a failure keeps the text and the client message id, so
 * retrying it later (even after a reload) is deduplicated by the message ledger.
 */
@Injectable()
export class DraftsService {
  constructor(
    private readonly access: InboxAccess,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(principal: StaffPrincipal, publicId: string): Promise<z.infer<typeof DraftsView>> {
    return this.access.tx(principal, async (tx) => {
      const { control } = await this.access.authorized(
        tx,
        principal,
        publicId,
        'conversations.read',
      );
      const rows = await tx
        .select()
        .from(d)
        .where(mine(control.id, principal.staffMemberId))
        .orderBy(asc(d.createdAt));
      return {
        drafts: rows
          .filter((r) => r.kind === 'draft')
          .map((r) => ({
            lane: r.lane,
            text: r.text,
            revision: r.revision,
            updatedAt: r.updatedAt.toISOString(),
          })),
        outgoing: rows
          .filter((r) => r.kind === 'outgoing' && r.clientMessageId)
          .map((r) => ({
            clientMessageId: r.clientMessageId as string,
            lane: r.lane,
            text: r.text,
            state: r.state === 'failed' ? ('failed' as const) : ('sending' as const),
            errorCode: (r.errorCode as ErrorCode | null) ?? null,
            updatedAt: r.updatedAt.toISOString(),
          })),
      };
    });
  }

  /** Saves a draft; a save based on an older revision (another tab) is VERSION_CONFLICT. */
  async save(
    principal: StaffPrincipal,
    publicId: string,
    lane: DraftLane,
    input: { text: string; baseRevision?: number | undefined },
  ): Promise<StaffDraft> {
    return this.access.tx(principal, async (tx) => {
      const { control } = await this.access.authorized(
        tx,
        principal,
        publicId,
        lane === 'internal' ? 'conversations.note' : 'conversations.reply',
      );
      const now = this.clock();
      const [existing] = await tx
        .select()
        .from(d)
        .where(
          and(mine(control.id, principal.staffMemberId), eq(d.kind, 'draft'), eq(d.lane, lane)),
        )
        .for('update');
      if (existing) {
        if (input.baseRevision !== undefined && input.baseRevision !== existing.revision) {
          throw new AppError('VERSION_CONFLICT', {
            detail: 'This draft was changed in another tab or window.',
          });
        }
        const [saved] = await tx
          .update(d)
          .set({ text: input.text, revision: sql`${d.revision} + 1`, updatedAt: now })
          .where(eq(d.id, existing.id))
          .returning();
        return view(saved ?? existing);
      }
      const [saved] = await tx
        .insert(d)
        .values({
          tenantId: principal.tenantId,
          conversationId: control.id,
          staffMemberId: principal.staffMemberId,
          lane,
          kind: 'draft',
          text: input.text,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!saved) throw new Error('draft insert returned nothing');
      return view(saved);
    });
  }

  async remove(principal: StaffPrincipal, publicId: string, lane: DraftLane): Promise<void> {
    await this.access.tx(principal, async (tx) => {
      const { control } = await this.access.authorized(
        tx,
        principal,
        publicId,
        'conversations.read',
      );
      await tx
        .delete(d)
        .where(
          and(mine(control.id, principal.staffMemberId), eq(d.kind, 'draft'), eq(d.lane, lane)),
        );
    });
  }

  async discardOutgoing(
    principal: StaffPrincipal,
    publicId: string,
    clientMessageId: string,
  ): Promise<void> {
    await this.access.tx(principal, async (tx) => {
      const { control } = await this.access.authorized(
        tx,
        principal,
        publicId,
        'conversations.read',
      );
      await tx
        .delete(d)
        .where(
          and(
            mine(control.id, principal.staffMemberId),
            eq(d.kind, 'outgoing'),
            eq(d.clientMessageId, clientMessageId),
          ),
        );
    });
  }

  /** Records a send before it goes out (inside the send's authorization transaction). */
  async startOutgoing(
    tx: TenantTx,
    input: {
      tenantId: string;
      conversationId: string;
      staffMemberId: string;
      lane: DraftLane;
      clientMessageId: string;
      text: string;
      clearDraft: boolean;
    },
  ): Promise<void> {
    const now = this.clock();
    await tx
      .insert(d)
      .values({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        staffMemberId: input.staffMemberId,
        lane: input.lane,
        kind: 'outgoing',
        text: input.text,
        clientMessageId: input.clientMessageId,
        state: 'sending',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [d.tenantId, d.conversationId, d.staffMemberId, d.clientMessageId],
        targetWhere: sql`${d.kind} = 'outgoing'`,
        set: { state: 'sending', errorCode: null, updatedAt: now },
      });
    if (input.clearDraft) {
      await tx
        .delete(d)
        .where(
          and(
            mine(input.conversationId, input.staffMemberId),
            eq(d.kind, 'draft'),
            eq(d.lane, input.lane),
          ),
        );
    }
  }

  /** The send was confirmed by the authority: nothing is left to retry. */
  async finishOutgoing(
    principal: StaffPrincipal,
    conversationId: string,
    clientMessageId: string,
  ): Promise<void> {
    await this.access.tx(principal, (tx) =>
      tx
        .delete(d)
        .where(
          and(
            mine(conversationId, principal.staffMemberId),
            eq(d.kind, 'outgoing'),
            eq(d.clientMessageId, clientMessageId),
          ),
        ),
    );
  }

  /** The send was not confirmed: keep it, with why, for a safe retry. */
  async failOutgoing(
    principal: StaffPrincipal,
    conversationId: string,
    clientMessageId: string,
    code: ErrorCode,
  ): Promise<void> {
    await this.access.tx(principal, (tx) =>
      tx
        .update(d)
        .set({ state: 'failed', errorCode: code, updatedAt: this.clock() })
        .where(
          and(
            mine(conversationId, principal.staffMemberId),
            eq(d.kind, 'outgoing'),
            eq(d.clientMessageId, clientMessageId),
          ),
        ),
    );
  }
}

function view(row: typeof schema.staffDrafts.$inferSelect): StaffDraft {
  return {
    lane: row.lane,
    text: row.text,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}
