import { z } from 'zod';
import { AttachmentsManifest, Manifest, ManifestLine, PackageRecord } from './model.js';

export const SCHEMA_ID = 'https://hamnivo.dev/schemas/migration/v1.json';

type JsonSchema = Record<string, unknown>;

/**
 * The JSON Schema of the package format (draft 2020-12), generated from the Zod model so the two
 * cannot drift. Validate `manifest.json` against `#/$defs/Manifest`, each line of
 * `records.ndjson` against `#/$defs/PackageRecord` and `attachments.json` against
 * `#/$defs/AttachmentsManifest`. Defaults are optional in the schema: producers may omit them.
 */
export function packageJsonSchema(): JsonSchema {
  const generated = z.toJSONSchema(
    z.object({
      manifest: Manifest,
      manifestLine: ManifestLine,
      record: PackageRecord,
      attachments: AttachmentsManifest,
    }),
    { target: 'draft-2020-12', io: 'input' },
  ) as JsonSchema;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'Hamnivo migration package v1',
    description:
      'A ZIP holding manifest.json (Manifest), records.ndjson (one PackageRecord per line: contacts, then each conversation followed by its messages), attachments.json (AttachmentsManifest) and the files under attachments/. A bare NDJSON package starts with a ManifestLine. Every record keeps a reference to where it came from in the source export.',
    $defs: generated.$defs,
    anyOf: [
      { $ref: '#/$defs/Manifest' },
      { $ref: '#/$defs/ManifestLine' },
      { $ref: '#/$defs/PackageRecord' },
      { $ref: '#/$defs/AttachmentsManifest' },
    ],
  };
}
