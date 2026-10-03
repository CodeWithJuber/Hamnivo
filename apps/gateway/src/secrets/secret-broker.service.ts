import type { CreateSecretRequest, SecretMetadata } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { iso } from '../common/views.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { hintOf, type KeyRing, open, rewrap, type Sealed, seal, secretAad } from './envelope.js';

type SecretView = z.infer<typeof SecretMetadata>;

function view(row: typeof schema.secrets.$inferSelect): SecretView {
  return {
    id: toPublicId('secret', row.id),
    kind: row.kind,
    label: row.label,
    masked: row.hint ? `••••${row.hint}` : '••••',
    createdAt: row.createdAt.toISOString(),
    rotatedAt: iso(row.rotatedAt),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
  };
}

/**
 * Secret broker (X04): stores credentials encrypted and hands plaintext only to server-side code
 * that asks for a specific secret inside its tenant. Values are never returned by the API, never
 * logged and never placed in AI prompts; callers receive them just in time and drop them.
 */
@Injectable()
export class SecretBroker {
  private readonly ring: KeyRing;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.ring = config.kek;
  }

  /** Stores a secret inside an existing tenant transaction (used by provisioning code). */
  async storeIn(
    tx: TenantTx,
    tenantId: string,
    input: { kind: string; label: string; value: string },
  ): Promise<string> {
    const id = newId();
    const sealed = seal(this.ring, input.value, secretAad(tenantId, id));
    await tx.insert(schema.secrets).values({
      id,
      tenantId,
      kind: input.kind,
      label: input.label,
      hint: hintOf(input.value),
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      wrappedKey: sealed.wrappedKey,
      kekVersion: sealed.kekVersion,
    });
    return id;
  }

  /** Replaces a stored secret's value inside an existing tenant transaction. */
  async rotateIn(tx: TenantTx, tenantId: string, secretId: string, value: string): Promise<void> {
    const sealed = seal(this.ring, value, secretAad(tenantId, secretId));
    const [row] = await tx
      .update(schema.secrets)
      .set({
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        wrappedKey: sealed.wrappedKey,
        kekVersion: sealed.kekVersion,
        hint: hintOf(value),
        rotatedAt: this.clock(),
      })
      .where(and(eq(schema.secrets.id, secretId), isNull(schema.secrets.revokedAt)))
      .returning({ id: schema.secrets.id });
    if (!row) throw new AppError('NOT_FOUND', { detail: 'The credential is missing or revoked.' });
  }

  /** Revokes a stored secret inside an existing tenant transaction (no-op when already revoked). */
  async revokeIn(tx: TenantTx, secretId: string): Promise<void> {
    await tx
      .update(schema.secrets)
      .set({ revokedAt: this.clock() })
      .where(and(eq(schema.secrets.id, secretId), isNull(schema.secrets.revokedAt)));
  }

  /** The masked form of a stored secret, e.g. `••••9f3a`, and when it was last replaced. */
  async maskedIn(
    tx: TenantTx,
    secretId: string,
  ): Promise<{ masked: string; rotatedAt: string | null }> {
    const [row] = await tx
      .select({ hint: schema.secrets.hint, rotatedAt: schema.secrets.rotatedAt })
      .from(schema.secrets)
      .where(eq(schema.secrets.id, secretId));
    return {
      masked: row?.hint ? `••••${row.hint}` : '••••',
      rotatedAt: iso(row?.rotatedAt ?? null),
    };
  }

  /**
   * Returns the plaintext for server-side use. Data keys wrapped with a retired KEK are rewrapped
   * with the active one on the way (lazy rotation).
   */
  async reveal(tx: TenantTx, tenantId: string, secretId: string): Promise<string> {
    const [row] = await tx
      .select()
      .from(schema.secrets)
      .where(and(eq(schema.secrets.id, secretId), isNull(schema.secrets.revokedAt)));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'The credential is missing or revoked.' });
    const sealed: Sealed = {
      ciphertext: row.ciphertext,
      iv: row.iv,
      wrappedKey: row.wrappedKey,
      kekVersion: row.kekVersion,
    };
    const value = open(this.ring, sealed, secretAad(tenantId, secretId));
    const rewrapped = rewrap(this.ring, sealed);
    await tx
      .update(schema.secrets)
      .set({
        lastUsedAt: this.clock(),
        ...(rewrapped !== sealed
          ? { wrappedKey: rewrapped.wrappedKey, kekVersion: rewrapped.kekVersion }
          : {}),
      })
      .where(eq(schema.secrets.id, secretId));
    return value;
  }

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    secretId: string,
    data: Record<string, unknown> = {},
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'secret',
      targetId: toPublicId('secret', secretId),
      outcome: 'success',
      data,
    });
  }

  async list(principal: StaffPrincipal): Promise<SecretView[]> {
    return this.tx(principal, async (tx) =>
      (await tx.select().from(schema.secrets).orderBy(asc(schema.secrets.createdAt))).map(view),
    );
  }

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateSecretRequest>,
  ): Promise<SecretView> {
    return this.tx(principal, async (tx) => {
      const id = await this.storeIn(tx, principal.tenantId, input);
      await this.audit(tx, principal, 'secret.created', id, {
        kind: input.kind,
        label: input.label,
      });
      const [row] = await tx.select().from(schema.secrets).where(eq(schema.secrets.id, id));
      if (!row) throw new Error('secret not stored');
      return view(row);
    });
  }

  async rotate(principal: StaffPrincipal, publicId: string, value: string): Promise<SecretView> {
    const id = this.parseId(publicId);
    return this.tx(principal, async (tx) => {
      const sealed = seal(this.ring, value, secretAad(principal.tenantId, id));
      const [row] = await tx
        .update(schema.secrets)
        .set({
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          wrappedKey: sealed.wrappedKey,
          kekVersion: sealed.kekVersion,
          hint: hintOf(value),
          rotatedAt: this.clock(),
        })
        .where(and(eq(schema.secrets.id, id), isNull(schema.secrets.revokedAt)))
        .returning();
      if (!row) throw new AppError('NOT_FOUND');
      await this.audit(tx, principal, 'secret.rotated', id);
      return view(row);
    });
  }

  async revoke(principal: StaffPrincipal, publicId: string): Promise<void> {
    const id = this.parseId(publicId);
    await this.tx(principal, async (tx) => {
      const [row] = await tx
        .update(schema.secrets)
        .set({ revokedAt: this.clock() })
        .where(and(eq(schema.secrets.id, id), isNull(schema.secrets.revokedAt)))
        .returning({ id: schema.secrets.id });
      if (row) await this.audit(tx, principal, 'secret.revoked', id);
    });
  }

  private parseId(publicId: string): string {
    try {
      return fromPublicId('secret', publicId);
    } catch {
      throw new AppError('NOT_FOUND');
    }
  }
}
