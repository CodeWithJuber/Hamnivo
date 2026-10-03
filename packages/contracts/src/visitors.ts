import { z } from 'zod';
import { SupportedLocale, Timestamp } from './common.js';
import { typeId } from './ids.js';

/**
 * Website visitors: the pages they view and whether they are on the site now, for staff to help in
 * context (the visitor card in the inbox and the live visitors page). The chat loader reports a
 * visitor only when the brand allows it and the visitor's browser does not send Do Not Track or
 * Global Privacy Control. No IP address is read or kept; the country comes from the
 * `CF-IPCountry` header Cloudflare adds, device and browser from the User-Agent header.
 */

/** Days a visitor's pages and visits are kept after the visitor was last seen. */
export const VISITOR_RETENTION_DAYS = 30;

/** A visit ends after this many seconds without a sign of life. */
export const VISIT_IDLE_SECONDS = 30 * 60;
/** A visitor counts as on the site when seen this recently. */
export const VISITOR_ONLINE_SECONDS = 150;

export const DeviceType = z.enum(['desktop', 'mobile', 'tablet', 'other']);
export type DeviceType = z.infer<typeof DeviceType>;

/** The random key a browser keeps for a brand's website (the server stores only its hash). */
export const VisitorKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

/**
 * What the loader reports from a visitor's browser. `view`: a page was opened; `beat`: the page
 * is still open (every 20 seconds while it shows); `leave`: the page was closed. A `beat` for a
 * different page than the last report counts as a view, so a missed navigation heals itself.
 */
export const VisitReport = z
  .object({
    widgetId: z.string().min(1).max(100),
    key: VisitorKey,
    event: z.enum(['view', 'beat', 'leave']),
    /** The page address; the server removes the query string unless the brand keeps it. */
    url: z.string().min(1).max(2000),
    title: z.string().max(300).optional(),
    /** The page the visitor came from. */
    referrer: z.string().max(2000).optional(),
    language: z.string().max(35).optional(),
  })
  .meta({ id: 'VisitReport' });
export type VisitReport = z.infer<typeof VisitReport>;

/** A message staff typed for a visitor, shown with the chat launcher. */
export const VisitorInvite = z
  .object({ id: z.string().min(1).max(64), message: z.string().min(1).max(300) })
  .meta({ id: 'VisitorInvite' });
export type VisitorInvite = z.infer<typeof VisitorInvite>;

export const VisitAck = z
  .object({
    /** False when the brand turned tracking off: the loader stops reporting on this page. */
    tracking: z.boolean(),
    invite: VisitorInvite.nullable(),
  })
  .meta({ id: 'VisitAck' });
export type VisitAck = z.infer<typeof VisitAck>;

/** The chat widget tells the gateway which browser it runs in, so staff see its pages. */
export const VisitorLinkRequest = z
  .object({ visitorKey: VisitorKey, locale: SupportedLocale.optional() })
  .meta({ id: 'VisitorLinkRequest' });
export type VisitorLinkRequest = z.infer<typeof VisitorLinkRequest>;

export const VisitorLinkResponse = z
  .object({
    tracking: z.boolean(),
    /** The line the widget shows to say pages are noted (null when they are not). */
    notice: z.string().max(300).nullable(),
    invite: VisitorInvite.nullable(),
  })
  .meta({ id: 'VisitorLinkResponse' });
export type VisitorLinkResponse = z.infer<typeof VisitorLinkResponse>;

// ------------------------------------------------------------------ what staff see

export const VisitorDevice = z.object({
  type: DeviceType,
  browser: z.string().nullable(),
  os: z.string().nullable(),
});
export type VisitorDevice = z.infer<typeof VisitorDevice>;

export const VisitorPage = z
  .object({ url: z.string(), title: z.string().nullable(), viewedAt: Timestamp })
  .meta({ id: 'VisitorPage' });
export type VisitorPage = z.infer<typeof VisitorPage>;

/** One visitor on the live visitors page. */
export const LiveVisitor = z
  .object({
    id: typeId('visitor'),
    brand: z.object({ id: typeId('brand'), name: z.string() }),
    /** The customer's name when they opened the chat and gave one, else "Visitor" and a short code. */
    name: z.string(),
    identified: z.boolean(),
    page: z.object({ url: z.string(), title: z.string().nullable() }),
    /** When this visit began; the time on site is the time since. */
    startedAt: Timestamp,
    lastSeenAt: Timestamp,
    country: z.string().length(2).nullable(),
    device: VisitorDevice,
    returning: z.boolean(),
    visitCount: z.int().min(1),
    referrer: z.string().nullable(),
    /** A conversation of this visitor that is still open, if any. */
    conversationId: typeId('conversation').nullable(),
    /** The person may send this visitor an invitation to chat. */
    canInvite: z.boolean(),
  })
  .meta({ id: 'LiveVisitor' });
export type LiveVisitor = z.infer<typeof LiveVisitor>;

export const LiveVisitorList = z
  .object({ items: z.array(LiveVisitor), generatedAt: Timestamp })
  .meta({ id: 'LiveVisitorList' });
export type LiveVisitorList = z.infer<typeof LiveVisitorList>;

export const LiveVisitorsQuery = z.object({ brandId: typeId('brand').optional() });

/** The visitor card next to a conversation. */
export const VisitorCard = z
  .object({
    id: typeId('visitor'),
    firstSeenAt: Timestamp,
    lastSeenAt: Timestamp,
    visitCount: z.int().min(1),
    returning: z.boolean(),
    /** On the site right now. */
    online: z.boolean(),
    country: z.string().length(2).nullable(),
    device: VisitorDevice,
    language: z.string().nullable(),
    referrer: z.string().nullable(),
    entryUrl: z.string(),
    currentPage: z.object({ url: z.string(), title: z.string().nullable() }),
    /** When the latest visit began and how long it has lasted (up to its last sign of life). */
    visitStartedAt: Timestamp,
    timeOnSiteSeconds: z.int().nonnegative(),
    /** Pages of the latest visit, newest first. */
    pages: z.array(VisitorPage).max(20),
  })
  .meta({ id: 'VisitorCard' });
export type VisitorCard = z.infer<typeof VisitorCard>;

export const ConversationVisitor = z
  .object({
    /** False when the brand does not note pages at all. */
    tracking: z.boolean(),
    visitor: VisitorCard.nullable(),
  })
  .meta({ id: 'ConversationVisitor' });
export type ConversationVisitor = z.infer<typeof ConversationVisitor>;

export const VisitorInviteRequest = z
  .object({ message: z.string().trim().min(1).max(300) })
  .meta({ id: 'VisitorInviteRequest' });
export type VisitorInviteRequest = z.infer<typeof VisitorInviteRequest>;

export const VisitorInviteResult = z
  .object({ expiresAt: Timestamp })
  .meta({ id: 'VisitorInviteResult' });
export type VisitorInviteResult = z.infer<typeof VisitorInviteResult>;

// ------------------------------------------------------------------ brand settings

export const VisitorSettings = z
  .object({
    /** Note which pages visitors view. On unless the brand turns it off. */
    tracking: z.boolean(),
    /** Keep the part of a page address after "?". Off: it is removed before anything is stored. */
    keepQueryStrings: z.boolean(),
  })
  .meta({ id: 'VisitorSettings' });
export type VisitorSettings = z.infer<typeof VisitorSettings>;

export const DEFAULT_VISITOR_SETTINGS: VisitorSettings = {
  tracking: true,
  keepQueryStrings: false,
};

export const VisitorSettingsView = z
  .object({
    brandId: typeId('brand'),
    settings: VisitorSettings,
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'VisitorSettingsView' });
export type VisitorSettingsView = z.infer<typeof VisitorSettingsView>;
