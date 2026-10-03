import { z } from 'zod';
import { SupportedLocale, Timestamp } from './common.js';
import { CustomerConversation } from './conversations.js';
import { ProactiveTriggerKind, WidgetLayoutMode } from './customer-surface.js';

export const LauncherPosition = z.enum(['bottom-right', 'bottom-left']);
/** @deprecated Use WidgetLayoutMode. */
export const WidgetMode = WidgetLayoutMode;

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
      /** Files one message may carry. */
      maxFiles: z.int().positive(),
    }),
    /** How the brand places the chat on its website (W02); the loader may override it. */
    layout: z.object({ mode: WidgetLayoutMode, position: LauncherPosition }),
    /** The home screen before a conversation (W17). */
    help: z.object({
      /** Suggested questions per language, in the brand's words. */
      suggestions: z.record(SupportedLocale, z.array(z.string().max(120))),
      /** Whether the brand's public knowledge can be searched from the widget. */
      search: z.boolean(),
    }),
    /** How long after sending a customer may delete a message (W23); 0 when they cannot. */
    messageDeletion: z.object({ windowSeconds: z.int().nonnegative() }),
    /** Whether verified customers are offered email notifications (W25). */
    notifications: z.object({ email: z.boolean() }),
    /** Proactive prompts the loader may show (W19), so the chat can open with the same words. */
    proactive: z.object({
      triggers: z.array(
        z.object({
          id: z.string(),
          kind: ProactiveTriggerKind,
          message: z.record(SupportedLocale, z.string().max(160)),
        }),
      ),
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
    /**
     * Origin of the page embedding the widget, as the loader saw it. Checked against the brand's
     * allowed websites. The browser enforces embedding itself with CSP frame-ancestors.
     */
    hostOrigin: z.url().max(300).optional(),
    /**
     * A test chat opened from Studio (the owner trying their own widget). Only then may the page
     * be Studio itself; the conversations it starts are marked as tests, so reports and counts
     * leave them out.
     */
    test: z.boolean().optional(),
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

/**
 * Which websites may show this widget in a frame. The TLS proxy in front of the widget sends it as
 * the page's CSP `frame-ancestors`, so other websites cannot embed a brand's chat.
 */
export const WidgetFramePolicy = z
  .object({
    widgetId: z.string(),
    /** CSP source expressions: the brand's allowed websites, or local pages when none are set. */
    frameAncestors: z.array(z.string()).min(1),
  })
  .meta({ id: 'WidgetFramePolicy' });
export type WidgetFramePolicy = z.infer<typeof WidgetFramePolicy>;

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
