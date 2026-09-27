import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  importJWK,
  importPKCS8,
  type JWK,
  jwtVerify,
  SignJWT,
} from 'jose';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { CLOCK, type Clock, CONFIG } from '../tokens.js';

export interface WidgetClaims {
  tenantId: string;
  brandId: string;
  principalId: string;
  sessionId: string;
  widgetId: string;
  verified: boolean;
  expiresAt: Date;
}

const ISSUER = 'hamnivo';

/** Refresh tokens are `<session uuid>.<secret>`; only a SHA-256 of the secret is stored. */
export function newRefreshSecret(): { secret: string; hash: Buffer } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: sha256(secret) };
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest();

export function sameHash(a: Buffer | null | undefined, b: Buffer): boolean {
  return Boolean(a) && (a as Buffer).length === b.length && timingSafeEqual(a as Buffer, b);
}

/**
 * Widget access tokens: ES256 JWTs for one principal on one widget, valid for minutes. Anything
 * that can verify them needs only the public key.
 */
@Injectable()
export class WidgetTokens implements OnModuleInit {
  private readonly logger = new Logger(WidgetTokens.name);
  private privateKey: CryptoKey | undefined;
  private publicKey: CryptoKey | undefined;
  private kid = 'widget-1';

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.WIDGET_SIGNING_KEY) {
      const pem = Buffer.from(this.config.WIDGET_SIGNING_KEY, 'base64').toString('utf8');
      this.privateKey = await importPKCS8(pem, 'ES256', { extractable: true });
    } else {
      if (this.config.NODE_ENV === 'production') {
        throw new Error('WIDGET_SIGNING_KEY is required in production (run scripts/setup/env.sh)');
      }
      this.logger.warn(
        'WIDGET_SIGNING_KEY is not set; using a temporary key (sessions end on restart)',
      );
      this.privateKey = (await generateKeyPair('ES256', { extractable: true })).privateKey;
    }
    const jwk = (await exportJWK(this.privateKey)) as JWK;
    const { d: _d, ...publicJwk } = jwk;
    this.kid = createHash('sha256')
      .update(`${publicJwk.x}.${publicJwk.y}`)
      .digest('base64url')
      .slice(0, 16);
    this.publicKey = (await importJWK({ ...publicJwk, alg: 'ES256' }, 'ES256')) as CryptoKey;
  }

  async issue(
    claims: Omit<WidgetClaims, 'expiresAt'>,
  ): Promise<{ token: string; expiresAt: Date }> {
    if (!this.privateKey) throw new Error('Widget token key not loaded');
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.config.WIDGET_TOKEN_MINUTES * 60_000);
    const token = await new SignJWT({
      tid: claims.tenantId,
      bid: claims.brandId,
      sid: claims.sessionId,
      wid: claims.widgetId,
      ver: claims.verified,
    })
      .setProtectedHeader({ alg: 'ES256', kid: this.kid, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(`widget:${claims.widgetId}`)
      .setSubject(claims.principalId)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .setJti(randomBytes(12).toString('base64url'))
      .sign(this.privateKey);
    return { token, expiresAt };
  }

  async verify(token: string): Promise<WidgetClaims> {
    if (!this.publicKey) throw new Error('Widget token key not loaded');
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: ISSUER,
        algorithms: ['ES256'],
        currentDate: this.clock(),
      });
      const wid = String(payload.wid ?? '');
      const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audience.includes(`widget:${wid}`)) throw new Error('audience mismatch');
      return {
        tenantId: String(payload.tid),
        brandId: String(payload.bid),
        principalId: String(payload.sub),
        sessionId: String(payload.sid),
        widgetId: wid,
        verified: payload.ver === true,
        expiresAt: new Date(Number(payload.exp) * 1000),
      };
    } catch (error) {
      const expired = error instanceof Error && 'code' in error && error.code === 'ERR_JWT_EXPIRED';
      throw new AppError(expired ? 'SESSION_EXPIRED' : 'AUTH_REQUIRED', {
        detail: expired
          ? 'The chat session expired; it renews automatically.'
          : 'A valid widget session is required.',
      });
    }
  }
}
