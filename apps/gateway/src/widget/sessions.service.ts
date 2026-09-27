import { IdentityAssertionClaims, type WidgetSession } from '@hamnivo/contracts';
import {
  type Db,
  fromPublicId,
  newId,
  resolveWidget,
  resolveWidgetSession,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { decodeProtectedHeader, importJWK, type JWK, jwtVerify } from 'jose';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { widgetConfig } from './copy.js';
import {
  newRefreshSecret,
  sameHash,
  sha256,
  type WidgetClaims,
  WidgetTokens,
} from './tokens.service.js';
import { principalConversations } from './views.js';

const REFRESH_GRACE_MS = 30_000;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

type SessionRow = typeof schema.widgetSessions.$inferSelect;
type PrincipalRow = typeof schema.customerPrincipals.$inferSelect;
type BrandRow = typeof schema.brands.$inferSelect;

/**
 * Widget sessions (W05, W13): anonymous principals by default, short-lived ES256 access tokens,
 * rotating refresh tokens with reuse detection, and verified identity only from assertions signed
 * by the tenant's backend. A different identity is a different principal, never a merge.
 */
@Injectable()
export class WidgetSessionsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tokens: WidgetTokens,
    private readonly secrets: SecretBroker,
  ) {}

  private checkOrigin(allowed: string[], hostOrigin: string | undefined) {
    if (allowed.length === 0) {
      // Not configured yet: only local development pages may embed the widget.
      if (hostOrigin === undefined || LOCAL_ORIGIN.test(hostOrigin)) return;
    } else if (hostOrigin !== undefined && allowed.includes(new URL(hostOrigin).origin)) {
      return;
    }
    throw new AppError('ORIGIN_NOT_ALLOWED', {
      detail: 'Add this website to the brand’s allowed websites to use the chat here.',
    });
  }

  async create(input: {
    widgetId: string;
    locale?: string;
    resumeToken?: string;
    hostOrigin?: string;
  }): Promise<WidgetSession> {
    const widget = await resolveWidget(this.db, input.widgetId);
    if (widget?.brandStatus !== 'active' || widget.tenantStatus !== 'active') {
      throw new AppError('NOT_FOUND', { detail: 'This chat is not available.' });
    }
    this.checkOrigin(widget.allowedOrigins, input.hostOrigin);
    if (input.resumeToken) {
      try {
        return await this.refresh(input.resumeToken, input.widgetId);
      } catch {
        // An expired or foreign resume token starts a fresh anonymous session instead.
      }
    }
    const now = this.clock();
    return withTenant(this.db, { tenantId: widget.tenantId, actorId: 'widget' }, async (tx) => {
      const [principal] = await tx
        .insert(schema.customerPrincipals)
        .values({
          tenantId: widget.tenantId,
          brandId: widget.brandId,
          kind: 'anonymous',
          locale: input.locale ?? null,
          lastSeenAt: now,
        })
        .returning();
      if (!principal) throw new Error('principal insert returned nothing');
      return this.openSession(
        tx,
        widget.tenantId,
        widget.brandId,
        principal,
        input.hostOrigin ?? 'unknown',
      );
    });
  }

  private async openSession(
    tx: TenantTx,
    tenantId: string,
    brandId: string,
    principal: PrincipalRow,
    hostOrigin: string,
  ): Promise<WidgetSession> {
    const now = this.clock();
    const refresh = newRefreshSecret();
    const [session] = await tx
      .insert(schema.widgetSessions)
      .values({
        id: newId(),
        tenantId,
        brandId,
        principalId: principal.id,
        refreshHash: refresh.hash,
        hostOrigin,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + this.config.WIDGET_SESSION_DAYS * 86_400_000),
      })
      .returning();
    if (!session) throw new Error('session insert returned nothing');
    return this.view(tx, session, principal, refresh.secret);
  }

  private async view(
    tx: TenantTx,
    session: SessionRow,
    principal: PrincipalRow,
    secret: string,
  ): Promise<WidgetSession> {
    const [brand] = await tx
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, session.brandId));
    if (!brand) throw new AppError('NOT_FOUND');
    const access = await this.tokens.issue({
      tenantId: session.tenantId,
      brandId: session.brandId,
      principalId: principal.id,
      sessionId: session.id,
      widgetId: brand.widgetPublicId,
      verified: principal.kind === 'verified',
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: `${toPublicId('session', session.id)}.${secret}`,
      principal: {
        id: toPublicId('customer', principal.id),
        verified: principal.kind === 'verified',
        displayName: principal.displayName,
      },
      config: widgetConfig(brand as BrandRow),
      conversations: await principalConversations(tx, principal.id),
    };
  }

  /** Rotates the refresh token. Reusing an old one revokes the session (theft detection). */
  async refresh(refreshToken: string, widgetId?: string): Promise<WidgetSession> {
    const expired = () =>
      new AppError('SESSION_EXPIRED', { detail: 'Please start a new chat session.' });
    const [sessionPart, secret] = refreshToken.split('.');
    if (!sessionPart || !secret) throw expired();
    let sessionId: string;
    try {
      sessionId = fromPublicId('session', sessionPart);
    } catch {
      throw expired();
    }
    const tenantId = await resolveWidgetSession(this.db, sessionId);
    if (!tenantId) throw expired();
    const now = this.clock();
    const outcome = await withTenant(this.db, { tenantId, actorId: 'widget' }, async (tx) => {
      const [session] = await tx
        .select()
        .from(schema.widgetSessions)
        .where(eq(schema.widgetSessions.id, sessionId))
        .for('update');
      if (!session || session.revokedAt || session.expiresAt <= now)
        return { error: true as const };
      const hash = sha256(secret);
      const current = sameHash(session.refreshHash, hash);
      const previous = sameHash(session.previousRefreshHash, hash);
      const withinGrace = now.getTime() - session.lastUsedAt.getTime() < REFRESH_GRACE_MS;
      if (!current && !(previous && withinGrace)) {
        if (previous) {
          await tx
            .update(schema.widgetSessions)
            .set({ revokedAt: now, revokeReason: 'refresh_token_reuse' })
            .where(eq(schema.widgetSessions.id, session.id));
        }
        return { error: true as const };
      }
      const [brand] = await tx
        .select()
        .from(schema.brands)
        .where(eq(schema.brands.id, session.brandId));
      if (brand?.status !== 'active' || (widgetId && brand.widgetPublicId !== widgetId)) {
        return { error: true as const };
      }
      const next = newRefreshSecret();
      const [rotated] = await tx
        .update(schema.widgetSessions)
        .set({
          refreshHash: next.hash,
          previousRefreshHash: current ? session.refreshHash : session.previousRefreshHash,
          generation: session.generation + 1,
          lastUsedAt: now,
        })
        .where(eq(schema.widgetSessions.id, session.id))
        .returning();
      const [principal] = await tx
        .select()
        .from(schema.customerPrincipals)
        .where(eq(schema.customerPrincipals.id, session.principalId));
      if (!rotated || !principal) return { error: true as const };
      return { error: false as const, value: await this.view(tx, rotated, principal, next.secret) };
    });
    if (outcome.error) throw expired();
    return outcome.value;
  }

  async reset(claims: WidgetClaims): Promise<void> {
    await withTenant(this.db, { tenantId: claims.tenantId, actorId: 'widget' }, (tx) =>
      tx
        .update(schema.widgetSessions)
        .set({ revokedAt: this.clock(), revokeReason: 'signed_out' })
        .where(eq(schema.widgetSessions.id, claims.sessionId)),
    );
  }

  /**
   * Verifies an identity assertion signed by the tenant's backend (kid → brand identity key,
   * audience = widget ID, at most five minutes, single-use jti). A different person than the
   * current principal gets a new principal and session; the old session is revoked, which also
   * closes its streams.
   */
  async identify(claims: WidgetClaims, assertion: string): Promise<WidgetSession> {
    const invalid = (detail: string) => new AppError('ASSERTION_INVALID', { detail });
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(assertion).kid;
    } catch {
      throw invalid('The identity assertion is malformed.');
    }
    if (!kid) throw invalid('The identity assertion has no key id (kid).');
    const now = this.clock();
    return withTenant(this.db, { tenantId: claims.tenantId, actorId: 'widget' }, async (tx) => {
      const [key] = await tx
        .select()
        .from(schema.brandIdentityKeys)
        .where(
          and(
            eq(schema.brandIdentityKeys.brandId, claims.brandId),
            eq(schema.brandIdentityKeys.kid, kid),
            inArray(schema.brandIdentityKeys.status, ['active', 'retiring']),
          ),
        );
      if (!key) throw invalid('Unknown signing key.');
      const verificationKey =
        key.alg === 'HS256'
          ? new TextEncoder().encode(
              await this.secrets.reveal(tx, claims.tenantId, key.secretId as string),
            )
          : await importJWK(key.publicJwk as JWK, key.alg);
      let payload: IdentityAssertionClaims;
      try {
        const verified = await jwtVerify(assertion, verificationKey, {
          algorithms: [key.alg],
          audience: claims.widgetId,
          maxTokenAge: '5m',
          currentDate: now,
          requiredClaims: ['sub', 'exp', 'iat', 'jti'],
        });
        payload = IdentityAssertionClaims.parse(verified.payload);
      } catch {
        throw invalid('The identity assertion could not be verified.');
      }
      if (payload.exp - payload.iat > 300)
        throw invalid('Identity assertions may be valid for at most five minutes.');
      const [nonce] = await tx
        .insert(schema.identityNonces)
        .values({
          tenantId: claims.tenantId,
          brandId: claims.brandId,
          jti: payload.jti,
          expiresAt: new Date(payload.exp * 1000),
        })
        .onConflictDoNothing()
        .returning({ jti: schema.identityNonces.jti });
      if (!nonce) throw invalid('This identity assertion was already used.');

      const [existing] = await tx
        .select()
        .from(schema.customerPrincipals)
        .where(
          and(
            eq(schema.customerPrincipals.brandId, claims.brandId),
            eq(schema.customerPrincipals.externalSubject, payload.sub),
          ),
        );
      const verifiedEmail = payload.email && payload.email_verified === true ? payload.email : null;
      let principal: PrincipalRow | undefined = existing;
      if (principal) {
        [principal] = await tx
          .update(schema.customerPrincipals)
          .set({
            displayName: payload.name ?? principal.displayName,
            ...(verifiedEmail ? { email: verifiedEmail, emailVerifiedAt: now } : {}),
            lastSeenAt: now,
          })
          .where(eq(schema.customerPrincipals.id, principal.id))
          .returning();
      } else {
        [principal] = await tx
          .insert(schema.customerPrincipals)
          .values({
            tenantId: claims.tenantId,
            brandId: claims.brandId,
            kind: 'verified',
            externalSubject: payload.sub,
            displayName: payload.name ?? null,
            email: verifiedEmail,
            emailVerifiedAt: verifiedEmail ? now : null,
            lastSeenAt: now,
          })
          .returning();
      }
      if (!principal) throw new Error('principal upsert returned nothing');
      const [current] = await tx
        .select()
        .from(schema.widgetSessions)
        .where(eq(schema.widgetSessions.id, claims.sessionId));
      await tx
        .update(schema.widgetSessions)
        .set({
          revokedAt: now,
          revokeReason: principal.id === claims.principalId ? 'reauthenticated' : 'identity_switch',
        })
        .where(eq(schema.widgetSessions.id, claims.sessionId));
      return this.openSession(
        tx,
        claims.tenantId,
        claims.brandId,
        principal,
        current?.hostOrigin ?? 'unknown',
      );
    });
  }
}
