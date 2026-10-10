import {
  IdentityAssertionClaims,
  type LauncherConfig,
  type WidgetFramePolicy,
  type WidgetSession,
} from '@hamnivo/contracts';
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
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { decodeProtectedHeader, importJWK, type JWK, jwtVerify } from 'jose';
import { asksAnyoneOnline } from '../automations/definitions.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { assertWidgetOnline, widgetLoads } from '../identity/tenants.readonly.js';
import { AvailabilityService } from '../inbox/availability.service.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { isBlocked } from '../visitors/blocks.js';
import { filesScannable } from './attachments.service.js';
import { consentState } from './consent.js';
import { launcherConfig, widgetConfig } from './copy.js';
import { recordSighting, SightingThrottle, sightedOrigin } from './install-sightings.js';
import { DIRECT_ORIGIN, frameAncestors, originAllowed, sessionOrigin } from './origins.js';
import { SessionSignals } from './session-signals.service.js';
import { brandSurface } from './settings.service.js';
import {
  newRefreshSecret,
  sameHash,
  sha256,
  type WidgetClaims,
  WidgetTokens,
} from './tokens.service.js';
import { principalConversations } from './views.js';

const REFRESH_GRACE_MS = 30_000;
/** Identity assertions may be dated up to this many seconds in the future (clock differences). */
const ASSERTION_CLOCK_TOLERANCE_SECONDS = 5;

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
  private readonly logger = new Logger(WidgetSessionsService.name);
  /** When each website was last noted as running the chat (HNV-01-04). */
  private readonly sightings = new SightingThrottle();

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tokens: WidgetTokens,
    private readonly secrets: SecretBroker,
    private readonly signals: SessionSignals,
    private readonly availability: AvailabilityService,
  ) {}

  /** `test`: a test chat opened from Studio, whose page is Studio itself (and never anyone else's). */
  private checkOrigin(allowed: string[], hostOrigin: string | undefined, test = false) {
    if (originAllowed(allowed, hostOrigin, test ? this.config.PUBLIC_CONSOLE_ORIGIN : undefined)) {
      return;
    }
    throw new AppError('ORIGIN_NOT_ALLOWED', {
      detail: 'Add this website to the brand’s allowed websites to use the chat here.',
    });
  }

  /**
   * Websites that may show this widget in a frame, matching the session origin check. The TLS
   * proxy sends it as CSP frame-ancestors on the widget page. A test chat (`test`) may also be
   * framed by Studio.
   */
  async framePolicy(widgetId: string, test = false): Promise<WidgetFramePolicy> {
    const widget = await resolveWidget(this.db, widgetId);
    if (widget?.brandStatus !== 'active' || !widgetLoads(widget.tenantStatus)) {
      throw new AppError('NOT_FOUND', { detail: 'This chat is not available.' });
    }
    return {
      widgetId,
      frameAncestors: frameAncestors(
        widget.allowedOrigins,
        test ? { studioOrigin: this.config.PUBLIC_CONSOLE_ORIGIN } : null,
      ),
    };
  }

  /**
   * What the loader needs before the chat loads (W02, W19). Public like the frame policy, but a
   * browser on a website the brand did not allow is refused (and gets no CORS permission).
   */
  async launcher(
    widgetId: string,
    origin: string | undefined,
    locale: string | undefined,
    country: string | null = null,
  ): Promise<LauncherConfig> {
    const widget = await resolveWidget(this.db, widgetId);
    if (widget?.brandStatus !== 'active' || !widgetLoads(widget.tenantStatus)) {
      throw new AppError('NOT_FOUND', { detail: 'This chat is not available.' });
    }
    if (origin !== undefined) this.checkOrigin(widget.allowedOrigins, origin);
    const config = await withTenant(this.db, { tenantId: widget.tenantId }, async (tx) => {
      const [brand] = await tx
        .select()
        .from(schema.brands)
        .where(eq(schema.brands.id, widget.brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'This chat is not available.' });
      const surface = await brandSurface(tx, brand.id);
      // Who is online costs a lookup, so it is asked only when a website rule needs it.
      const staffOnline = asksAnyoneOnline(surface.prompts)
        ? await this.availability.anyOnline(tx, widget.tenantId, {
            workspaceId: brand.workspaceId,
            brandId: brand.id,
          })
        : undefined;
      return launcherConfig(brand, surface, locale, this.clock(), {
        country,
        ...(staffOnline === undefined ? {} : { staffOnline }),
      });
    });
    await this.noteSighting(widget, origin);
    return config;
  }

  /**
   * The chat's code ran on one of the brand's websites (HNV-01-04): noted every few minutes at
   * most, in its own transaction. A failure never stops the chat from loading.
   */
  private async noteSighting(
    widget: { tenantId: string; brandId: string; allowedOrigins: string[] },
    origin: string | undefined,
  ): Promise<void> {
    const seen = sightedOrigin(widget.allowedOrigins, origin);
    const at = this.clock();
    if (!seen || !this.sightings.due(widget.brandId, seen, at.getTime())) return;
    try {
      await withTenant(this.db, { tenantId: widget.tenantId }, (tx) =>
        recordSighting(tx, {
          tenantId: widget.tenantId,
          brandId: widget.brandId,
          origin: seen,
          at,
        }),
      );
    } catch (error) {
      this.sightings.forget(widget.brandId, seen);
      this.logger.warn(`Could not note where the chat runs: ${String(error)}`);
    }
  }

  async create(input: {
    widgetId: string;
    locale?: string;
    resumeToken?: string;
    hostOrigin?: string;
    test?: boolean;
    /** Opened from the brand's direct chat link (W28), not from a website. */
    direct?: boolean;
    /** The request's country (CF-IPCountry), only to decide whether consent is asked. */
    country?: string | null;
  }): Promise<WidgetSession> {
    const widget = await resolveWidget(this.db, input.widgetId);
    if (widget?.brandStatus !== 'active') {
      throw new AppError('NOT_FOUND', { detail: 'This chat is not available.' });
    }
    assertWidgetOnline(widget.tenantStatus);
    const country = input.country ?? null;
    if (input.direct) {
      await this.checkDirectLink(widget.tenantId, widget.brandId);
    } else {
      this.checkOrigin(widget.allowedOrigins, input.hostOrigin, input.test === true);
    }
    if (input.resumeToken) {
      try {
        return await this.refresh(input.resumeToken, input.widgetId, country);
      } catch {
        // An expired or foreign resume token starts a fresh anonymous session instead.
      }
    }
    const now = this.clock();
    const origin = input.direct ? DIRECT_ORIGIN : (input.hostOrigin ?? 'unknown');
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
      return this.openSession(tx, widget.tenantId, widget.brandId, principal, origin, country);
    });
  }

  /** A chat from the direct link (W28) may start only while the brand keeps the link on. */
  private async checkDirectLink(tenantId: string, brandId: string): Promise<void> {
    const on = await withTenant(this.db, { tenantId, actorId: 'widget' }, async (tx) => {
      const [row] = await tx
        .select({ directLink: schema.brandWidgetSettings.directLink })
        .from(schema.brandWidgetSettings)
        .where(eq(schema.brandWidgetSettings.brandId, brandId));
      return row?.directLink === true;
    });
    if (!on) {
      throw new AppError('ORIGIN_NOT_ALLOWED', {
        detail: 'This chat cannot be opened from a link. Please use the chat on the website.',
      });
    }
  }

  private async openSession(
    tx: TenantTx,
    tenantId: string,
    brandId: string,
    principal: PrincipalRow,
    hostOrigin: string,
    country: string | null,
    identityKeyId: string | null = null,
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
        identityKeyId,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + this.config.WIDGET_SESSION_DAYS * 86_400_000),
      })
      .returning();
    if (!session) throw new Error('session insert returned nothing');
    return this.view(tx, session, principal, refresh.secret, country);
  }

  private async view(
    tx: TenantTx,
    session: SessionRow,
    principal: PrincipalRow,
    secret: string,
    country: string | null,
  ): Promise<WidgetSession> {
    const [brand] = await tx
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, session.brandId));
    if (!brand) throw new AppError('NOT_FOUND');
    const surface = await brandSurface(tx, brand.id);
    const consent = await consentState(tx, surface, principal.id, country);
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
      config: widgetConfig(brand as BrandRow, this.clock(), surface, {
        filesScannable: filesScannable(this.config),
        staffOnline: await this.availability.anyOnline(tx, session.tenantId, {
          workspaceId: brand.workspaceId,
          brandId: brand.id,
        }),
        consentRequired: consent.required,
        consentGiven: consent.given,
        direct: session.hostOrigin === DIRECT_ORIGIN,
        chatAvailable: !(await isBlocked(tx, brand.id, principal.id, this.clock())),
      }),
      conversations: await principalConversations(tx, principal.id),
    };
  }

  /** Rotates the refresh token. Reusing an old one revokes the session (theft detection). */
  async refresh(
    refreshToken: string,
    widgetId?: string,
    country: string | null = null,
  ): Promise<WidgetSession> {
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
      const [tenant] = await tx.select({ status: schema.tenants.status }).from(schema.tenants);
      // The session outlives a suspension; the chat is offline until the workspace is back.
      assertWidgetOnline(tenant?.status ?? 'closing');
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
      // A website removed from the brand's list can no longer keep its chats going. A test chat
      // from Studio never was on the list: it began as a test, which is the only way in. A chat
      // from the direct link keeps going only while the brand keeps the link on (W28).
      const allowed =
        session.hostOrigin === DIRECT_ORIGIN
          ? (await brandSurface(tx, brand.id)).directLink
          : originAllowed(
              brand.allowedOrigins,
              sessionOrigin(session.hostOrigin),
              this.config.PUBLIC_CONSOLE_ORIGIN,
            );
      if (!allowed) return { error: true as const };
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
      return {
        error: false as const,
        value: await this.view(tx, rotated, principal, next.secret, country),
      };
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
    // Its open streams end now (W18), not at their next heartbeat.
    await this.signals.ended(claims.tenantId, [claims.sessionId]);
  }

  /**
   * Verifies an identity assertion signed by the tenant's backend (kid → brand identity key,
   * audience = widget ID, at most five minutes, single-use jti). A different person than the
   * current principal gets a new principal and session; the old session is revoked, which also
   * closes its streams.
   */
  async identify(
    claims: WidgetClaims,
    assertion: string,
    country: string | null = null,
  ): Promise<WidgetSession> {
    const invalid = (detail: string) => new AppError('ASSERTION_INVALID', { detail });
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(assertion).kid;
    } catch {
      throw invalid('The identity assertion is malformed.');
    }
    if (!kid) throw invalid('The identity assertion has no key id (kid).');
    const now = this.clock();
    const session = await this.verifyAndSwitch(claims, assertion, kid, now, invalid, country);
    // The previous session's streams end now (W18): nothing of the previous person keeps flowing.
    await this.signals.ended(claims.tenantId, [claims.sessionId]);
    return session;
  }

  private verifyAndSwitch(
    claims: WidgetClaims,
    assertion: string,
    kid: string,
    now: Date,
    invalid: (detail: string) => AppError,
    country: string | null,
  ): Promise<WidgetSession> {
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
          // The website's clock may run a little ahead of or behind this server's.
          clockTolerance: ASSERTION_CLOCK_TOLERANCE_SECONDS,
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
        country,
        key.id,
      );
    });
  }
}
