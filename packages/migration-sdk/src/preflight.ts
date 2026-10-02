import { matchesPath } from './fields.js';
import type { Counts } from './model.js';
import type {
  FieldObservation,
  Issue,
  IssueCode,
  ItemKind,
  KnownLimit,
  ParsedSource,
  SourceDescriptor,
  SourceSystem,
} from './types.js';

export interface IssueSummary {
  code: IssueCode;
  severity: 'error' | 'warning';
  count: number;
  /** A few affected objects (IDs and places in the export only). */
  examples: Array<{ kind?: ItemKind; sourceId?: string; location?: string; detail?: string }>;
}

/** What the export contains and what will happen to it, before anything is imported (M01). */
export interface SourcePreflight {
  source: { system: SourceSystem; schemaVersion: string | null; files: number };
  counts: {
    contacts: number;
    conversations: number;
    messages: number;
    internalNotes: number;
    attachments: number;
    attachmentFiles: number;
  };
  declared: Partial<Counts> | null;
  truncated: boolean;
  /** Field paths seen in the export with how Hamnivo treats them (schema sample). */
  fields: FieldObservation[];
  /** Required fields the export does not contain: records cannot be imported without them. */
  missingRequired: string[];
  limits: KnownLimit[];
  issues: IssueSummary[];
  /** Nothing can be imported from this export as it is. */
  blocking: boolean;
}

const BLOCKING: ReadonlySet<IssueCode> = new Set(['no_conversations']);

export function summarizeIssues(issues: readonly Issue[], examples = 5): IssueSummary[] {
  const groups = new Map<string, IssueSummary>();
  for (const issue of issues) {
    const key = `${issue.severity}:${issue.code}`;
    let group = groups.get(key);
    if (!group) {
      group = { code: issue.code, severity: issue.severity, count: 0, examples: [] };
      groups.set(key, group);
    }
    group.count += 1;
    if (group.examples.length < examples) {
      group.examples.push({
        ...(issue.kind ? { kind: issue.kind } : {}),
        ...(issue.sourceId ? { sourceId: issue.sourceId } : {}),
        ...(issue.location ? { location: issue.location } : {}),
        ...(issue.detail ? { detail: issue.detail } : {}),
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || b.count - a.count,
  );
}

export function preflight(parsed: ParsedSource, descriptor: SourceDescriptor): SourcePreflight {
  const messages = parsed.conversations.flatMap((c) => c.messages);
  const attachments = [...parsed.attachments.values()];
  const missingRequired = descriptor.fields
    .filter((f) => f.required)
    .filter((f) => !parsed.fields.some((o) => o.count > 0 && matchesPath(f.source, o.path)))
    .map((f) => f.source);
  const issues = summarizeIssues(parsed.issues);
  return {
    source: { system: parsed.system, schemaVersion: parsed.schemaVersion, files: parsed.files },
    counts: {
      contacts: parsed.contacts.length,
      conversations: parsed.conversations.length,
      messages: messages.length,
      internalNotes: messages.filter((m) => m.visibility === 'internal').length,
      attachments: attachments.length,
      attachmentFiles: attachments.filter((a) => a.bytes !== null).length,
    },
    declared: parsed.declared,
    truncated: parsed.truncated,
    fields: parsed.fields,
    missingRequired: parsed.conversations.length > 0 ? missingRequired : [],
    limits: descriptor.limits,
    issues,
    blocking: issues.some((i) => BLOCKING.has(i.code)) || missingRequired.length > 0,
  };
}
