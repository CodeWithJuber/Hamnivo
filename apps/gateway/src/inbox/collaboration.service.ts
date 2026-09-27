import type {
  ConversationLink,
  ConversationReview,
  LinkRequest,
  ReviewRequest,
} from '@hamnivo/contracts';
import { appendAudit, fromPublicId, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from './access.js';
import { InboxSignals } from './signals.service.js';

const reviewer = alias(schema.staffMembers, 'reviewer');
const subject = alias(schema.staffMembers, 'subject');

/**
 * Supervisor review (H14) and linked cases (H17). Reviews are private to people who may review;
 * links connect two conversations about one case without merging their transcripts, and are only
 * shown where the viewer may see the other conversation too.
 */
@Injectable()
export class CollaborationService {
  constructor(
    private readonly access: InboxAccess,
    private readonly signals: InboxSignals,
  ) {}

  async reviews(principal: StaffPrincipal, publicId: string): Promise<ConversationReview[]> {
    return this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.review');
      const rows = await tx
        .select({
          review: schema.conversationReviews,
          reviewerName: reviewer.displayName,
          subjectName: subject.displayName,
        })
        .from(schema.conversationReviews)
        .innerJoin(reviewer, eq(reviewer.id, schema.conversationReviews.reviewerId))
        .leftJoin(subject, eq(subject.id, schema.conversationReviews.subjectStaffId))
        .where(eq(schema.conversationReviews.conversationId, found.control.id))
        .orderBy(desc(schema.conversationReviews.createdAt));
      return rows.map((row) => ({
        id: toPublicId('review', row.review.id),
        rating: row.review.rating,
        note: row.review.note,
        reviewer: {
          staffMemberId: toPublicId('staff', row.review.reviewerId),
          displayName: row.reviewerName,
        },
        subject: row.review.subjectStaffId
          ? {
              staffMemberId: toPublicId('staff', row.review.subjectStaffId),
              displayName: row.subjectName ?? '',
            }
          : null,
        createdAt: row.review.createdAt.toISOString(),
      }));
    });
  }

  async review(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof ReviewRequest>,
  ): Promise<ConversationReview> {
    const id = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.review');
      const subjectId = input.subjectStaffMemberId
        ? fromPublicId('staff', input.subjectStaffMemberId)
        : (found.control.ownerStaffId ?? null);
      if (subjectId) {
        const [staff] = await tx
          .select({ id: schema.staffMembers.id })
          .from(schema.staffMembers)
          .where(eq(schema.staffMembers.id, subjectId));
        if (!staff) {
          throw new AppError('VALIDATION_FAILED', {
            fields: [{ path: 'subjectStaffMemberId', message: 'Unknown staff member.' }],
          });
        }
      }
      const [row] = await tx
        .insert(schema.conversationReviews)
        .values({
          tenantId: principal.tenantId,
          conversationId: found.control.id,
          reviewerId: principal.staffMemberId,
          subjectStaffId: subjectId,
          rating: input.rating,
          note: input.note?.trim() || null,
        })
        .returning({ id: schema.conversationReviews.id });
      if (!row) throw new Error('review insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'conversation.reviewed',
        targetType: 'conversation',
        targetId: publicId,
        outcome: 'success',
        data: {
          rating: input.rating,
          subject: subjectId ? toPublicId('staff', subjectId) : null,
        },
      });
      return row.id;
    });
    const all = await this.reviews(principal, publicId);
    const created = all.find((r) => r.id === toPublicId('review', id));
    if (!created) throw new Error('review not found after insert');
    return created;
  }

  private async linkViews(
    tx: TenantTx,
    principal: StaffPrincipal,
    conversationId: string,
  ): Promise<ConversationLink[]> {
    const l = schema.conversationLinks;
    const rows = await tx
      .select({ link: l, creatorName: schema.staffMembers.displayName })
      .from(l)
      .innerJoin(schema.staffMembers, eq(schema.staffMembers.id, l.createdBy))
      .where(or(eq(l.conversationId, conversationId), eq(l.linkedConversationId, conversationId)))
      .orderBy(desc(l.createdAt));
    const views: ConversationLink[] = [];
    for (const row of rows) {
      const otherId =
        row.link.conversationId === conversationId
          ? row.link.linkedConversationId
          : row.link.conversationId;
      const other = await this.access.load(tx, toPublicId('conversation', otherId));
      // A link never reveals a conversation the viewer could not open.
      if (!other || !this.access.can(principal, 'conversations.read', other.resource)) continue;
      const [customer] = other.control.principalId
        ? await tx
            .select({ name: schema.customerPrincipals.displayName })
            .from(schema.customerPrincipals)
            .where(eq(schema.customerPrincipals.id, other.control.principalId))
        : [];
      views.push({
        id: toPublicId('link', row.link.id),
        conversation: {
          id: toPublicId('conversation', otherId),
          customerName: customer?.name?.trim() || 'Visitor',
          status: other.control.authorityStatus,
          lastActivityAt: other.control.lastActivityAt.toISOString(),
        },
        note: row.link.note,
        createdBy: {
          staffMemberId: toPublicId('staff', row.link.createdBy),
          displayName: row.creatorName,
        },
        createdAt: row.link.createdAt.toISOString(),
      });
    }
    return views;
  }

  async links(principal: StaffPrincipal, publicId: string): Promise<ConversationLink[]> {
    return this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.read');
      return this.linkViews(tx, principal, found.control.id);
    });
  }

  async link(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof LinkRequest>,
  ): Promise<ConversationLink> {
    const result = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.note');
      const other = await this.access.authorized(
        tx,
        principal,
        input.conversationId,
        'conversations.read',
      );
      if (other.control.id === found.control.id) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'conversationId', message: 'Choose another conversation.' }],
        });
      }
      const [low, high] = [found.control.id, other.control.id].sort() as [string, string];
      let linkId: string;
      try {
        const [row] = await tx.transaction(async (sp) =>
          sp
            .insert(schema.conversationLinks)
            .values({
              tenantId: principal.tenantId,
              conversationId: low,
              linkedConversationId: high,
              note: input.note?.trim() || null,
              createdBy: principal.staffMemberId,
            })
            .returning({ id: schema.conversationLinks.id }),
        );
        if (!row) throw new Error('link insert returned nothing');
        linkId = row.id;
      } catch (error) {
        if (!isUniqueViolation(error, 'conversation_links_pair_key')) throw error;
        const [existing] = await tx
          .select({ id: schema.conversationLinks.id })
          .from(schema.conversationLinks)
          .where(
            and(
              eq(schema.conversationLinks.conversationId, low),
              eq(schema.conversationLinks.linkedConversationId, high),
            ),
          );
        if (!existing) throw error;
        linkId = existing.id;
      }
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'conversation.linked',
        targetType: 'conversation',
        targetId: publicId,
        outcome: 'success',
        data: { linked: input.conversationId },
      });
      const views = await this.linkViews(tx, principal, found.control.id);
      return { views, linkId, ids: [found.control.id, other.control.id] };
    });
    await this.signals.changed(principal.tenantId, result.ids);
    const view = result.views.find((v) => v.id === toPublicId('link', result.linkId));
    if (!view) throw new Error('link not visible after insert');
    return view;
  }

  async unlink(principal: StaffPrincipal, publicId: string, linkPublicId: string): Promise<void> {
    await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.read');
      enforce(this.access.decide(principal, 'conversations.note', found.resource));
      const l = schema.conversationLinks;
      const deleted = await tx
        .delete(l)
        .where(
          and(
            eq(l.id, fromPublicId('link', linkPublicId)),
            or(
              eq(l.conversationId, found.control.id),
              eq(l.linkedConversationId, found.control.id),
            ),
          ),
        )
        .returning({ id: l.id });
      if (deleted.length === 0) throw new AppError('NOT_FOUND', { detail: 'Link not found.' });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'conversation.unlinked',
        targetType: 'conversation',
        targetId: publicId,
        outcome: 'success',
        data: { link: linkPublicId },
      });
    });
  }
}
