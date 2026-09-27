import type {
  AttachmentEntry,
  ContactRecord,
  ConversationRecord,
  Counts,
  MessageRecord,
} from './model.js';

export const SOURCE_SYSTEMS = ['tawk.to', 'hamnivo', 'chatwoot', 'intercom', 'zendesk'] as const;
export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

export type ItemKind = 'contact' | 'conversation' | 'message' | 'attachment';

/**
 * Why an object was not imported as is. Codes are stable: Studio translates them and reports
 * count them. Details never contain message text or personal data.
 */
export const REASONS = [
  'duplicate_existing',
  'duplicate_in_file',
  'invalid_record',
  'missing_time',
  'unsupported_type',
  'unsupported_sender',
  'missing_conversation',
  'missing_contact',
  'empty_message',
  'missing_attachment',
  'binary_not_in_export',
  'checksum_mismatch',
  'type_mismatch',
  'too_large',
  'malware',
  'scan_unavailable',
  'authority_rejected',
  'authority_unavailable',
  'parent_failed',
  'not_referenced',
  'cancelled',
  'truncated',
] as const;
export type Reason = (typeof REASONS)[number];

export type IssueCode =
  | Reason
  | 'invalid_json'
  | 'truncated_file'
  | 'count_mismatch'
  | 'export_cap_reached'
  | 'incomplete_package'
  | 'no_conversations'
  | 'unknown_file';

/** Something a reader noticed; `sourceId` names the object when there is one. */
export interface Issue {
  severity: 'error' | 'warning';
  code: IssueCode;
  kind?: ItemKind;
  sourceId?: string;
  /** Conversation the object belongs to, for messages and attachments. */
  conversationId?: string;
  /** Where in the export: file name and, for NDJSON, the line. Never content. */
  location?: string;
  detail?: string;
}

/** A field path seen in the export, how often and how Hamnivo treats it (schema sample). */
export interface FieldObservation {
  path: string;
  count: number;
  types: string[];
  status: FieldStatus;
  target: string | null;
}

export type FieldStatus = 'supported' | 'transformed' | 'unsupported';

export interface FieldMapping {
  /** Path in the source (`messages[].msg`); `*` matches one segment. */
  source: string;
  /** What it becomes in Hamnivo and Chatwoot, as a stable key. */
  target: string;
  status: FieldStatus;
  /** Records cannot be imported without it. */
  required?: boolean;
}

/** Known limits of a source, shown before anything is imported (M01). */
export interface KnownLimit {
  code: string;
  severity: 'info' | 'warning';
}

export interface SourceDescriptor {
  system: SourceSystem;
  /** Accepted uploads, or `api` for a connector. */
  accepts: Array<'zip' | 'json' | 'ndjson' | 'api'>;
  fields: FieldMapping[];
  limits: KnownLimit[];
}

export interface ParsedConversation {
  record: ConversationRecord;
  /** Valid messages in their original order (by time, then position in the export). */
  messages: MessageRecord[];
}

export interface ParsedAttachment {
  entry: AttachmentEntry;
  /** The file's bytes when the export contains them. */
  bytes: Uint8Array | null;
  /** Why the file cannot be imported, found while reading. */
  problem: Reason | null;
}

/** An export read into the canonical model, with everything that could not be read listed. */
export interface ParsedSource {
  system: SourceSystem;
  schemaVersion: string | null;
  contacts: ContactRecord[];
  conversations: ParsedConversation[];
  attachments: Map<string, ParsedAttachment>;
  /** Objects that were found but cannot be imported, and export-level findings. */
  issues: Issue[];
  fields: FieldObservation[];
  /** What the export says it contains, where it says so. */
  declared: Partial<Counts> | null;
  /** The export is cut short or declares more than it holds. */
  truncated: boolean;
  /** Files read from the export. */
  files: number;
  /**
   * Where the records come from, as the export says (a package's `manifest.source`). Source IDs
   * are unique only within it, so deduplication across imports is scoped to it.
   */
  origin: { system: string; account: string | null } | null;
}

export interface FileSourceAdapter {
  descriptor: SourceDescriptor;
  /** Reads an export already unpacked into files (name → bytes). */
  parse(files: Map<string, Uint8Array>): ParsedSource;
}
