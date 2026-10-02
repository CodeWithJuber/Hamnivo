import { z } from 'zod';

/**
 * The canonical migration model and the Hamnivo package format v1 (M02). Every source adapter
 * produces these records; the package writer stores them as NDJSON, and the JSON Schema in
 * `schema/hamnivo-migration-v1.schema.json` is generated from them.
 */

export const PACKAGE_FORMAT = 'hamnivo.migration';
export const PACKAGE_VERSION = 1;
export const RECORDS_FILE = 'records.ndjson';
export const ATTACHMENTS_FILE = 'attachments.json';
export const MANIFEST_FILE = 'manifest.json';

const Id = z.string().min(1).max(512);
const Timestamp = z.iso.datetime({ offset: true });
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Where an object came from: the source system, its ID there and its place in the raw export. */
export const SourceRef = z
  .object({
    system: z.string().min(1).max(64),
    id: Id,
    schemaVersion: z.string().max(64).optional(),
    /** File in the original export and a JSON Pointer into it (a reference, not a copy). */
    raw: z
      .object({ file: z.string().max(512), pointer: z.string().max(512).optional() })
      .optional(),
  })
  .meta({ id: 'SourceRef' });
export type SourceRef = z.infer<typeof SourceRef>;

/** Flat values kept as attributes; nested structures are not copied. */
export const Attributes = z
  .record(
    z.string().min(1).max(128),
    z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
  )
  .meta({ id: 'Attributes' });

export const ContactRecord = z
  .object({
    type: z.literal('contact'),
    id: Id,
    source: SourceRef,
    name: z.string().max(255).nullable(),
    /**
     * An identity the source verified (for example a signed-in account). Only this is ever used
     * to recognise the same person twice.
     */
    verified: z
      .object({ subject: z.string().min(1).max(255), issuer: z.string().max(255).optional() })
      .nullable()
      .default(null),
    /** Addresses the person typed in. Kept for reference; never used to match or contact them. */
    unverified: z
      .object({ email: z.string().max(320).optional(), phone: z.string().max(64).optional() })
      .default({}),
    location: z
      .object({ city: z.string().max(128).optional(), countryCode: z.string().max(8).optional() })
      .optional(),
    attributes: Attributes.default({}),
  })
  .meta({ id: 'ContactRecord' });
export type ContactRecord = z.infer<typeof ContactRecord>;

export const CONVERSATION_STATUSES = ['open', 'pending', 'resolved', 'snoozed'] as const;

export const ConversationRecord = z
  .object({
    type: z.literal('conversation'),
    id: Id,
    source: SourceRef,
    contactId: Id,
    status: z.enum(CONVERSATION_STATUSES),
    startedAt: Timestamp,
    endedAt: Timestamp.nullable().optional(),
    subject: z.string().max(500).nullable().optional(),
    channel: z.string().max(64).nullable().optional(),
    labels: z.array(z.string().min(1).max(64)).max(50).default([]),
    assignee: z
      .object({ name: z.string().max(255).nullable(), sourceId: z.string().max(255).nullable() })
      .nullable()
      .optional(),
    /** How many messages the source says the conversation has; fewer means it was cut short. */
    declaredMessageCount: z.int().nonnegative().nullable().optional(),
    attributes: Attributes.default({}),
  })
  .meta({ id: 'ConversationRecord' });
export type ConversationRecord = z.infer<typeof ConversationRecord>;

export const AUTHOR_KINDS = ['customer', 'agent', 'bot', 'system'] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export const MessageRecord = z
  .object({
    type: z.literal('message'),
    id: Id,
    source: SourceRef,
    conversationId: Id,
    /** Original time in the source system. */
    createdAt: Timestamp,
    author: z.object({
      kind: z.enum(AUTHOR_KINDS),
      name: z.string().max(255).nullable().optional(),
      sourceId: z.string().max(255).nullable().optional(),
    }),
    /** `internal` notes are for staff only and stay private when imported. */
    visibility: z.enum(['public', 'internal']),
    text: z.string().max(150_000).nullable(),
    attachmentIds: z.array(Id).max(20).default([]),
    /** The source's own message type, for the record. */
    sourceType: z.string().max(64).optional(),
  })
  .meta({ id: 'MessageRecord' });
export type MessageRecord = z.infer<typeof MessageRecord>;

/** One line of `records.ndjson`. */
export const PackageRecord = z
  .discriminatedUnion('type', [ContactRecord, ConversationRecord, MessageRecord])
  .meta({ id: 'PackageRecord' });
export type PackageRecord = z.infer<typeof PackageRecord>;
export type PackageRecordInput = z.input<typeof PackageRecord>;

/** A file attached to a message, listed in the attachments manifest. */
export const AttachmentEntry = z
  .object({
    id: Id,
    messageId: Id,
    name: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(255),
    size: z.int().nonnegative(),
    sha256: Sha256.nullable(),
    /** The file inside the package (`attachments/…`); null when the source gave only a link. */
    path: z.string().max(512).nullable(),
    /** Link in the source system, kept as a reference. Hamnivo never downloads from it. */
    url: z.string().max(2048).nullable().optional(),
  })
  .meta({ id: 'AttachmentEntry' });
export type AttachmentEntry = z.infer<typeof AttachmentEntry>;

export const AttachmentsManifest = z
  .object({ items: z.array(AttachmentEntry) })
  .meta({ id: 'AttachmentsManifest' });

export const Counts = z
  .object({
    contacts: z.int().nonnegative(),
    conversations: z.int().nonnegative(),
    messages: z.int().nonnegative(),
    attachments: z.int().nonnegative(),
  })
  .meta({ id: 'Counts' });
export type Counts = z.infer<typeof Counts>;

export const Manifest = z
  .object({
    format: z.literal(PACKAGE_FORMAT),
    version: z.literal(PACKAGE_VERSION),
    createdAt: Timestamp,
    generator: z.object({ name: z.string().min(1).max(128), version: z.string().max(64) }),
    source: z.object({
      system: z.string().min(1).max(64),
      schemaVersion: z.string().max(64).optional(),
      exportedAt: Timestamp.optional(),
      account: z.string().max(255).optional(),
    }),
    /** What the package holds; a reader finding fewer records reports the package as cut short. */
    counts: Counts,
    files: z
      .object({
        records: z.string().min(1).max(255).default(RECORDS_FILE),
        attachments: z.string().min(1).max(255).default(ATTACHMENTS_FILE),
      })
      .default({ records: RECORDS_FILE, attachments: ATTACHMENTS_FILE }),
    /** sha256 of the records and attachments files, so a damaged file is detected. */
    checksums: z.record(z.string().min(1).max(255), Sha256).default({}),
    /** False when the producer knows something is missing (for example files it could not get). */
    complete: z.boolean(),
    notes: z.array(z.string().max(500)).max(50).default([]),
  })
  .meta({ id: 'Manifest' });
export type Manifest = z.infer<typeof Manifest>;
export type ManifestInput = z.input<typeof Manifest>;

/** A bare NDJSON package starts with the manifest as its first line. */
export const ManifestLine = Manifest.extend({ type: z.literal('manifest') }).meta({
  id: 'ManifestLine',
});
