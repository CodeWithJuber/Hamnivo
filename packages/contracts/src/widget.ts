import { z } from 'zod';
import { SupportedLocale, Timestamp } from './common.js';
import { CustomerConversation } from './conversations.js';

export const LauncherPosition = z.enum(['bottom-right', 'bottom-left']);
export const WidgetMode = z.enum(['bubble', 'inline', 'fullscreen']);

/** Public widget configuration. Nothing here is secret; the widget ID is not a credential. */
export const WidgetConfig = z
  .object({
    widgetId: z.string(),
    /** Immutable published configuration version (A07: saved is not live). */
    version: z.int().positive(),
    brand: z.object({
      name: z.string().max(80),
      logoUrl: z.url().nullable(),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      onAccent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      radius: z.int().min(0).max(24),
      launcherPosition: LauncherPosition,
    }),
    locales: z.object({ default: SupportedLocale, available: z.array(SupportedLocale).min(1) }),
    /** Per-locale copy authored by the tenant. */
    copy: z.record(
      SupportedLocale,
      z.object({
        greeting: z.string().max(300),
        aiDisclosure: z.string().max(300),
        offlineMessage: z.string().max(300),
        privacyNotice: z.string().max(500).nullable(),
      }),
    ),
    availability: z.object({
      /** True only when an actual human route exists right now (W11). */
      humanAvailable: z.boolean(),
      nextOpenAt: Timestamp.nullable(),
      timezone: z.string(),
    }),
    features: z.object({
      attachments: z.boolean(),
      helpCenter: z.boolean(),
      csat: z.boolean(),
      voice: z.boolean(),
      identityRequiredForHistory: z.boolean(),
    }),
    privacyPolicyUrl: z.url().nullable(),
    attachmentLimits: z.object({
      maxBytes: z.int().positive(),
      allowedMimeTypes: z.array(z.string()),
    }),
  })
  .meta({ id: 'WidgetConfig' });
export type WidgetConfig = z.infer<typeof WidgetConfig>;

export const CreateWidgetSessionRequest = z
  .object({
    widgetId: z.string(),
    locale: SupportedLocale.optional(),
    /** Refresh token from a previous session on this device (resumes the anonymous principal). */
    resumeToken: z.string().max(512).optional(),
  })
  .meta({ id: 'CreateWidgetSessionRequest' });

export const WidgetPrincipal = z.object({
  id: z.string(),
  verified: z.boolean(),
  displayName: z.string().nullable(),
});

export const WidgetSession = z
  .object({
    /** Short-lived bearer token (≈15 min) scoped to this widget and principal. */
    accessToken: z.string(),
    accessTokenExpiresAt: Timestamp,
    /** Rotating refresh token; reuse of an old one revokes the session (theft detection). */
    refreshToken: z.string(),
    principal: WidgetPrincipal,
    config: WidgetConfig,
    conversations: z.array(CustomerConversation),
  })
  .meta({ id: 'WidgetSession' });
export type WidgetSession = z.infer<typeof WidgetSession>;

export const RefreshWidgetSessionRequest = z
  .object({ refreshToken: z.string().max(512) })
  .meta({ id: 'RefreshWidgetSessionRequest' });

export const IdentifyRequest = z
  .object({
    /**
     * Compact JWS minted by the tenant's backend (see @hamnivo/server): subject, audience = widget ID,
     * expiry ≤ 5 minutes, unique jti. Browser-supplied emails or IDs confer no authority.
     */
    assertion: z.string().min(20).max(4096),
  })
  .meta({ id: 'IdentifyRequest' });

/** Claims inside an identity assertion. */
export const IdentityAssertionClaims = z.object({
  sub: z.string().min(1).max(200),
  aud: z.string(),
  iat: z.int(),
  exp: z.int(),
  jti: z.string().min(8).max(128),
  name: z.string().max(120).optional(),
  email: z.email().optional(),
  email_verified: z.boolean().optional(),
});
export type IdentityAssertionClaims = z.infer<typeof IdentityAssertionClaims>;
