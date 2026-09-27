import { randomUUID } from 'node:crypto';
import { type Db, schema, toPublicId, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { ConnectionRuntime } from '../authority/registry.js';
import type { AppConfig } from '../config.js';
import { openDirect, sealDirect } from '../secrets/envelope.js';
import { APP_DB, CONFIG } from '../tokens.js';

const aad = (tenantId: string, rowId: string) =>
  Buffer.from(`hamnivo:authority-contact:v1:${tenantId}:${rowId}`);

type PrincipalRow = typeof schema.customerPrincipals.$inferSelect;

/**
 * A customer principal's Chatwoot contact in one inbox. The contact-inbox source id grants
 * Client-API access to the conversation, so Hamnivo generates it, stores it encrypted before
 * calling Chatwoot (retries reuse it) and never sends it to a browser.
 */
@Injectable()
export class AuthorityContactsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  identifierOf(principal: PrincipalRow): string {
    return principal.kind === 'verified' && principal.externalSubject
      ? `hv:${toPublicId('brand', principal.brandId)}:${principal.externalSubject}`
      : `hv:anon:${toPublicId('customer', principal.id)}`;
  }

  /** Decrypts the stored source id (bound to its tenant and row). */
  sourceIdOf(tenantId: string, row: typeof schema.authorityContacts.$inferSelect): string {
    return openDirect(
      this.config.kek,
      { ciphertext: row.sourceIdCiphertext, iv: row.sourceIdIv, kekVersion: row.kekVersion },
      aad(tenantId, row.id),
    );
  }

  /** Returns the Chatwoot source id for the principal in the inbox, creating the contact once. */
  async ensure(
    runtime: ConnectionRuntime,
    inbox: { id: string; externalInboxId: number },
    principal: PrincipalRow,
  ): Promise<string> {
    const tenantId = runtime.tenantId;
    const identifier = this.identifierOf(principal);
    const pending = await withTenant(this.db, { tenantId }, async (tx) => {
      const where = and(
        eq(schema.authorityContacts.connectionId, runtime.connectionId),
        eq(schema.authorityContacts.inboxId, inbox.id),
        eq(schema.authorityContacts.principalId, principal.id),
      );
      const [existing] = await tx.select().from(schema.authorityContacts).where(where);
      if (existing) return { row: existing, sourceId: this.sourceIdOf(tenantId, existing) };
      const id = randomUUID();
      const sourceId = randomUUID();
      const sealed = sealDirect(this.config.kek, sourceId, aad(tenantId, id));
      await tx
        .insert(schema.authorityContacts)
        .values({
          id,
          tenantId,
          connectionId: runtime.connectionId,
          inboxId: inbox.id,
          principalId: principal.id,
          identifier,
          sourceIdCiphertext: sealed.ciphertext,
          sourceIdIv: sealed.iv,
          kekVersion: sealed.kekVersion,
        })
        .onConflictDoNothing();
      const [row] = await tx.select().from(schema.authorityContacts).where(where);
      if (!row) throw new Error('contact row missing after insert');
      return { row, sourceId: this.sourceIdOf(tenantId, row) };
    });
    if (pending.row.externalContactId !== null) return pending.sourceId;
    const contact = await runtime.authority.ensureContact({
      inboxRef: String(inbox.externalInboxId),
      identifier,
      sourceId: pending.sourceId,
      name: principal.displayName,
      verifiedEmail: principal.emailVerifiedAt ? principal.email : null,
    });
    await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .update(schema.authorityContacts)
        .set({ externalContactId: Number(contact.contactRef) })
        .where(eq(schema.authorityContacts.id, pending.row.id)),
    );
    return pending.sourceId;
  }
}
