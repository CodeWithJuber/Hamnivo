import { type Db, schema, toPublicId, withTenant } from '@hamnivo/db';
import type { AuthorityMessage } from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { ControlRow } from '../authority/ownership.service.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { authorityMessageUuid } from '../authority/uuid.js';
import { APP_DB } from '../tokens.js';
import { AuthorityContactsService } from '../widget/contacts.service.js';

/** A customer message as memory sees it: its public id, text and time. */
export interface CustomerMessage {
  ref: string;
  text: string;
  at: Date;
}

/**
 * The customer's own messages in a conversation, from the customer view of the authority (private
 * notes and activity never appear there). Memory is only ever built from these.
 */
@Injectable()
export class ConversationHistory {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly registry: AuthorityRegistry,
    private readonly contacts: AuthorityContactsService,
  ) {}

  async customerMessages(tenantId: string, control: ControlRow): Promise<CustomerMessage[]> {
    if (!control.principalId) return [];
    const principalId = control.principalId;
    const contact = await withTenant(this.db, { tenantId }, async (tx) => {
      const [row] = await tx
        .select({ contact: schema.authorityContacts, inbox: schema.authorityInboxes })
        .from(schema.authorityContacts)
        .innerJoin(
          schema.authorityInboxes,
          eq(schema.authorityInboxes.id, schema.authorityContacts.inboxId),
        )
        .where(
          and(
            eq(schema.authorityContacts.inboxId, control.inboxId),
            eq(schema.authorityContacts.principalId, principalId),
          ),
        );
      return row ?? null;
    });
    if (!contact) return [];
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const messages: AuthorityMessage[] = await runtime.authority.listMessages(
      String(control.externalConversationId),
      {
        view: 'customer',
        contactSourceId: this.contacts.sourceIdOf(tenantId, contact.contact),
        inboxRef: String(contact.inbox.externalInboxId),
      },
    );
    return messages
      .filter((m) => m.direction === 'incoming' && !m.private && m.text?.trim())
      .sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Number(a.ref) - Number(b.ref),
      )
      .map((m) => ({
        ref: toPublicId('message', authorityMessageUuid(control.connectionId, m.ref)),
        text: (m.text ?? '').trim(),
        at: m.createdAt,
      }));
  }
}
