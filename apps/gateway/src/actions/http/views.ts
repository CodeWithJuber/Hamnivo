import type { HttpToolSource } from '@hamnivo/contracts';
import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { type PortableSchema, sanitizeToolSchema } from '@hamnivo/domain/actions';
import { eq, inArray } from 'drizzle-orm';
import { argumentsOf } from './definition.js';

export type SourceRow = typeof schema.httpToolSources.$inferSelect;
type EndpointRow = typeof schema.httpToolEndpoints.$inferSelect;
type ToolRow = typeof schema.toolDefinitions.$inferSelect;

const METHOD_ORDER = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 } as const;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A tool's arguments schema as stored (portable subset), or an empty one when it cannot be read. */
function portable(tool: ToolRow): PortableSchema {
  const parsed = sanitizeToolSchema(tool.inputSchema, { trusted: false });
  return parsed.ok ? parsed.schema : { type: 'object' };
}

function endpointView(endpoint: EndpointRow, tool: ToolRow): HttpToolSource['endpoints'][number] {
  return {
    toolId: toPublicId('tool', tool.id),
    toolName: tool.name,
    title: tool.title,
    description: tool.description,
    method: endpoint.method,
    path: endpoint.pathTemplate,
    risk: tool.risk,
    status: tool.status,
    revision: tool.revision,
    editable: endpoint.operationId === null,
    arguments: argumentsOf(portable(tool), endpoint.parameters, endpoint.bodyFields),
  };
}

/**
 * Services of custom HTTP tools as Studio shows them: their tools, and the last characters of the
 * credential (never more). A removed service is not shown.
 */
export async function sourceViews(tx: TenantTx, rows: SourceRow[]): Promise<HttpToolSource[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const found = await tx
    .select({ endpoint: schema.httpToolEndpoints, tool: schema.toolDefinitions })
    .from(schema.httpToolEndpoints)
    .innerJoin(
      schema.toolDefinitions,
      eq(schema.toolDefinitions.id, schema.httpToolEndpoints.toolId),
    )
    .where(inArray(schema.httpToolEndpoints.sourceId, ids));
  // By path, and by method within a path, so a list reads the same however the tools were added.
  found.sort(
    (a, b) =>
      compare(a.endpoint.pathTemplate, b.endpoint.pathTemplate) ||
      METHOD_ORDER[a.endpoint.method] - METHOD_ORDER[b.endpoint.method] ||
      compare(a.tool.name, b.tool.name),
  );
  const secretIds = rows.flatMap((row) => (row.authSecretId ? [row.authSecretId] : []));
  const hints = secretIds.length
    ? await tx
        .select({ id: schema.secrets.id, hint: schema.secrets.hint })
        .from(schema.secrets)
        .where(inArray(schema.secrets.id, secretIds))
    : [];
  return rows.map((row) => ({
    id: toPublicId('httpSource', row.id),
    brandId: toPublicId('brand', row.brandId),
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    auth: {
      kind: row.authKind,
      header: row.authHeader,
      masked: row.authSecretId
        ? `••••${hints.find((h) => h.id === row.authSecretId)?.hint ?? ''}`
        : null,
    },
    specTitle: row.specTitle,
    specVersion: row.specVersion,
    // A removed source is not listed; only the two states a person can see are in the contract.
    status: row.status === 'disabled' ? 'disabled' : 'active',
    endpoints: found
      .filter((f) => f.endpoint.sourceId === row.id)
      .map((f) => endpointView(f.endpoint, f.tool)),
    createdAt: row.createdAt.toISOString(),
  }));
}
