import { randomBytes } from 'node:crypto';
import type { CreatedIdentityKey, CreateIdentityKeyRequest, IdentityKey } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { importJWK, type JWK } from 'jose';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type KeyRow = typeof schema.brandIdentityKeys.$inferSelect;

/** Members a public key may carry, per key type; everything else (such as `d`) is refused. */
const PUBLIC_MEMBERS: Record<string, readonly string[]> = {
  EC: ['kty', 'crv', 'x', 'y'],
  OKP: ['kty', 'crv', 'x'],
  RSA: ['kty', 'n', 'e'],
};
const EXPECTED: Record<string, { kty: string; crv?: string }> = {
  ES256: { kty: 'EC', crv: 'P-256' },
  EdDSA: { kty: 'OKP', crv: 'Ed25519' },
  RS256: { kty: 'RSA' },
};
const IGNORED_MEMBERS = new Set(['kid', 'alg', 'use', 'key_ops', 'ext']);

function view(row: KeyRow): IdentityKey {
  return {
    kid: row.kid,
    alg: row.alg,
    status: row.status,
    publicJwk: (row.publicJwk as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
  };
}

function invalidKey(message: string): AppError {
  return new AppError('VALIDATION_FAILED', { fields: [{ path: 'publicJwk', message }] });
}

/** Checks a public JWK for the algorithm and returns only its public members. */
async function publicKeyFor(
  alg: 'ES256' | 'EdDSA' | 'RS256',
  jwk: Record<string, unknown>,
): Promise<Record<string, string>> {
  const expected = EXPECTED[alg] as { kty: string; crv?: string };
  if (jwk.kty !== expected.kty || (expected.crv && jwk.crv !== expected.crv)) {
    throw invalidKey(
      `${alg} needs a ${expected.kty}${expected.crv ? ` ${expected.crv}` : ''} public key.`,
    );
  }
  const allowed = PUBLIC_MEMBERS[expected.kty] ?? [];
  const extra = Object.keys(jwk).filter((k) => !allowed.includes(k) && !IGNORED_MEMBERS.has(k));
  if (extra.length > 0) {
    throw invalidKey(`Send the public key only (remove: ${extra.join(', ')}).`);
  }
  const clean = Object.fromEntries(allowed.map((k) => [k, jwk[k]])) as Record<string, string>;
  if (Object.values(clean).some((v) => typeof v !== 'string' || v.length === 0)) {
    throw invalidKey('The key is incomplete.');
  }
  if (alg === 'RS256' && Buffer.from(clean.n ?? '', 'base64url').length < 256) {
    throw invalidKey('RSA keys must have at least 2048 bits.');
  }
  try {
    await importJWK(clean as JWK, alg);
  } catch {
    throw invalidKey('The key could not be read.');
  }
  return clean;
}

/**
 * Keys that verify the identity assertions a brand's backend signs for its customers (W12). A key
 * lets its holder vouch for any customer of the brand, so managing keys needs a grant of
 * `widget.identity_keys`, two-step verification and a recent sign-in.
 */
@Injectable()
export class IdentityKeysService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  /** The brand, if it exists and the person holds `permission` there. */
  private async brand(
    tx: TenantTx,
    principal: StaffPrincipal,
    brandPublicId: string,
    permission: Permission,
  ) {
    let brandId: string;
    try {
      brandId = fromPublicId('brand', brandPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    }
    const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    enforce(
      authorize(
        principal,
        permission,
        { workspaceId: brand.workspaceId, brandId: brand.id },
        { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
      ),
    );
    return brand;
  }

  async list(principal: StaffPrincipal, brandPublicId: string): Promise<IdentityKey[]> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId, 'widget.configure');
      const rows = await tx
        .select()
        .from(schema.brandIdentityKeys)
        .where(eq(schema.brandIdentityKeys.brandId, brand.id))
        .orderBy(asc(schema.brandIdentityKeys.createdAt));
      return rows.map(view);
    });
  }

  async create(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: z.output<typeof CreateIdentityKeyRequest>,
  ): Promise<CreatedIdentityKey> {
    const publicJwk = input.alg === 'HS256' ? null : await publicKeyFor(input.alg, input.publicJwk);
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId, 'widget.identity_keys');
      const kid = input.kid ?? `hk_${randomBytes(9).toString('base64url')}`;
      const [taken] = await tx
        .select({ kid: schema.brandIdentityKeys.kid })
        .from(schema.brandIdentityKeys)
        .where(
          and(
            eq(schema.brandIdentityKeys.brandId, brand.id),
            eq(schema.brandIdentityKeys.kid, kid),
          ),
        );
      if (taken) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'kid', message: 'This brand already has a key with this id.' }],
        });
      }
      const secret = input.alg === 'HS256' ? randomBytes(32).toString('base64url') : undefined;
      const secretId = secret
        ? await this.secrets.storeIn(tx, principal.tenantId, {
            kind: 'identity_hmac_key',
            label: `${brand.name}: identity key ${kid}`,
            value: secret,
          })
        : null;
      const [row] = await tx
        .insert(schema.brandIdentityKeys)
        .values({
          tenantId: principal.tenantId,
          brandId: brand.id,
          kid,
          alg: input.alg,
          publicJwk,
          secretId,
        })
        .returning();
      if (!row) throw new Error('identity key insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'brand.identity_key.created',
        targetType: 'brand',
        targetId: toPublicId('brand', brand.id),
        outcome: 'success',
        data: { kid, alg: input.alg },
      });
      return { ...view(row), ...(secret ? { secret } : {}) };
    });
  }

  async retire(principal: StaffPrincipal, brandPublicId: string, kid: string) {
    return this.end(principal, brandPublicId, kid, 'retiring');
  }

  async revoke(principal: StaffPrincipal, brandPublicId: string, kid: string) {
    return this.end(principal, brandPublicId, kid, 'revoked');
  }

  private async end(
    principal: StaffPrincipal,
    brandPublicId: string,
    kid: string,
    status: 'retiring' | 'revoked',
  ): Promise<IdentityKey> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId, 'widget.identity_keys');
      const where = and(
        eq(schema.brandIdentityKeys.brandId, brand.id),
        eq(schema.brandIdentityKeys.kid, kid),
      );
      const [row] = await tx.select().from(schema.brandIdentityKeys).where(where).for('update');
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Key not found.' });
      if (row.status === 'revoked' || row.status === status) return view(row);
      const now = this.clock();
      const [updated] = await tx
        .update(schema.brandIdentityKeys)
        .set({ status, retiredAt: row.retiredAt ?? now })
        .where(where)
        .returning();
      if (!updated) throw new Error('identity key update returned nothing');
      if (status === 'revoked' && row.secretId) {
        await tx
          .update(schema.secrets)
          .set({ revokedAt: now })
          .where(eq(schema.secrets.id, row.secretId));
      }
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: status === 'revoked' ? 'brand.identity_key.revoked' : 'brand.identity_key.retired',
        targetType: 'brand',
        targetId: toPublicId('brand', brand.id),
        outcome: 'success',
        data: { kid },
      });
      return view(updated);
    });
  }
}
