import type { InboxMessage } from '@hamnivo/contracts';
import { fromPublicId, schema, toPublicId } from '@hamnivo/db';
import type { ActorCredential, AuthorityMessage } from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { authorityUnavailable } from '../authority/outbound.service.js';
import type { ControlRow } from '../authority/ownership.service.js';
import { AuthorityRegistry, type ConnectionRuntime } from '../authority/registry.js';
import { StaffLinksService } from '../authority/staff-links.service.js';
import { authorityMessageUuid } from '../authority/uuid.js';
import { contractMessage, publicationFacts } from '../authority/views.js';
import { AppError } from '../common/app-error.js';
import { InboxAccess } from './access.js';

/** Chatwoot returns message pages of this size going backwards. */
const PAGE = 20;

function decodeBefore(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ref = Buffer.from(value, 'base64url').toString('utf8');
  if (!/^\d{1,18}$/.test(ref)) {
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ path: 'before', message: 'Unknown cursor' }],
    });
  }
  return ref;
}

/**
 * The staff transcript (H03, H06): public messages, internal notes and activity, read from Chatwoot
 * with the staff member's own Chatwoot user, so Chatwoot's permissions apply as well as Hamnivo's.
 */
@Injectable()
export class InboxMessagesService {
  constructor(
    private readonly access: InboxAccess,
    private readonly registry: AuthorityRegistry,
    private readonly staffLinks: StaffLinksService,
  ) {}

  /** The staff member's Chatwoot identity in this conversation's account (created on first use). */
  async actor(
    principal: StaffPrincipal,
    control: ControlRow,
  ): Promise<{ runtime: ConnectionRuntime; actor: ActorCredential; userRef: string }> {
    const runtime = await this.registry.get(principal.tenantId, control.connectionId);
    const userRef = String(await this.staffLinks.ensure(runtime, principal.staffMemberId));
    return { runtime, actor: { kind: 'staff', userRef }, userRef };
  }

  async list(
    principal: StaffPrincipal,
    publicId: string,
    query: { before?: string | undefined },
  ): Promise<{ items: InboxMessage[]; olderCursor: string | null }> {
    const before = decodeBefore(query.before);
    const found = await this.access.tx(principal, (tx) =>
      this.access.authorized(tx, principal, publicId, 'conversations.read'),
    );
    const control = found.control;
    const { runtime, actor } = await this.actor(principal, control);
    let messages: AuthorityMessage[];
    try {
      messages = await runtime.authority.listStaffMessages(
        String(control.externalConversationId),
        before ? { before } : {},
        actor,
      );
    } catch (error) {
      throw authorityUnavailable(error, 'Messages could not be loaded. Please try again.');
    }
    const items = await this.view(principal, control, messages);
    const oldest = messages[0];
    return {
      items: items.reverse(),
      olderCursor:
        messages.length >= PAGE && oldest ? Buffer.from(oldest.ref).toString('base64url') : null,
    };
  }

  /** Maps authority messages to the staff view, oldest first. */
  async view(
    principal: StaffPrincipal,
    control: ControlRow,
    messages: AuthorityMessage[],
  ): Promise<InboxMessage[]> {
    const userRefs = [
      ...new Set(
        messages
          .filter((m) => m.sender.kind === 'user')
          .map((m) => Number((m.sender as { ref: string }).ref))
          .filter(Number.isSafeInteger),
      ),
    ];
    const context = await this.access.tx(principal, async (tx) => {
      const facts = await publicationFacts(tx, control.id, messages);
      const links = userRefs.length
        ? await tx
            .select({
              externalUserId: schema.staffAuthorityLinks.externalUserId,
              staffMemberId: schema.staffAuthorityLinks.staffMemberId,
            })
            .from(schema.staffAuthorityLinks)
            .where(
              and(
                eq(schema.staffAuthorityLinks.connectionId, control.connectionId),
                inArray(schema.staffAuthorityLinks.externalUserId, userRefs),
              ),
            )
        : [];
      const ledger = await tx
        .select({
          clientMessageId: schema.messageLedger.clientMessageId,
          authorityMessageId: schema.messageLedger.authorityMessageId,
        })
        .from(schema.messageLedger)
        .where(
          and(
            eq(schema.messageLedger.conversationId, control.id),
            eq(schema.messageLedger.senderKind, 'staff'),
            eq(schema.messageLedger.senderId, principal.staffMemberId),
          ),
        );
      return { facts, links, ledger };
    });
    const staffOf = new Map(context.links.map((l) => [String(l.externalUserId), l.staffMemberId]));
    const mine = new Map(
      context.ledger
        .filter((l) => l.authorityMessageId !== null)
        .map((l) => [String(l.authorityMessageId), l.clientMessageId]),
    );
    const conversationId = toPublicId('conversation', control.id);
    return [...messages]
      .sort((a, b) => Number(a.ref) - Number(b.ref))
      .map((message) => {
        const facts = context.facts.get(message.ref);
        const view = contractMessage({
          message,
          id: toPublicId('message', authorityMessageUuid(control.connectionId, message.ref)),
          conversationId,
          sequence: null,
          clientMessageId: mine.get(message.ref) ?? null,
          delivery: message.direction === 'incoming' ? 'accepted' : null,
          ...(facts ? { facts } : {}),
        });
        const senderStaff =
          message.sender.kind === 'user' ? staffOf.get(message.sender.ref) : undefined;
        // Notes Hamnivo itself wrote (handoff packets, late-reply warnings) come from the
        // integration user, which is no staff member.
        const hamnivoNote =
          message.private &&
          message.sender.kind === 'user' &&
          senderStaff === undefined &&
          Boolean(message.key?.startsWith('hv1:n:'));
        return {
          ...view,
          ...(hamnivoNote ? { sender: { kind: 'system' as const, displayName: 'Hamnivo' } } : {}),
          system:
            message.direction === 'activity'
              ? ('activity' as const)
              : hamnivoNote
                ? ('hamnivo_note' as const)
                : null,
          mine: senderStaff === principal.staffMemberId,
        };
      });
  }

  /** Finds one message of the conversation by its public id (recent pages only). */
  async find(
    principal: StaffPrincipal,
    control: ControlRow,
    messagePublicId: string,
  ): Promise<AuthorityMessage> {
    const wanted = fromPublicId('message', messagePublicId);
    const { runtime, actor } = await this.actor(principal, control);
    let before: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      let messages: AuthorityMessage[];
      try {
        messages = await runtime.authority.listStaffMessages(
          String(control.externalConversationId),
          before ? { before } : {},
          actor,
        );
      } catch (error) {
        throw authorityUnavailable(error, 'The message could not be loaded.');
      }
      const match = messages.find(
        (m) => authorityMessageUuid(control.connectionId, m.ref) === wanted,
      );
      if (match) return match;
      const oldest = messages[0];
      if (!oldest || messages.length < PAGE) break;
      before = oldest.ref;
    }
    throw new AppError('NOT_FOUND', { detail: 'Message not found.' });
  }
}
