import type { McpServer } from '@hamnivo/contracts';
import { schema, type TenantTx } from '@hamnivo/db';
import { count, inArray } from 'drizzle-orm';
import { serverView } from './views.js';

type ServerRow = typeof schema.mcpServers.$inferSelect;

/**
 * MCP servers as Studio shows them: tool counts, the last characters of a pasted token, and how a
 * sign-in stands (a token from an OAuth sign-in is never shown, only that it is connected).
 */
export async function serverViews(tx: TenantTx, rows: ServerRow[]): Promise<McpServer[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const tools = await tx
    .select({
      server: schema.toolDefinitions.mcpServerId,
      status: schema.toolDefinitions.status,
      n: count(),
    })
    .from(schema.toolDefinitions)
    .where(inArray(schema.toolDefinitions.mcpServerId, ids))
    .groupBy(schema.toolDefinitions.mcpServerId, schema.toolDefinitions.status);
  const secretIds = rows.flatMap((r) => (r.tokenSecretId ? [r.tokenSecretId] : []));
  const hints = secretIds.length
    ? await tx
        .select({ id: schema.secrets.id, hint: schema.secrets.hint })
        .from(schema.secrets)
        .where(inArray(schema.secrets.id, secretIds))
    : [];
  const signIns = await tx
    .select()
    .from(schema.mcpServerOauth)
    .where(inArray(schema.mcpServerOauth.mcpServerId, ids));
  return rows.map((row) => {
    const mine = tools.filter((t) => t.server === row.id);
    const hint = hints.find((h) => h.id === row.tokenSecretId)?.hint;
    return serverView(
      row,
      {
        tools: mine.reduce((sum, t) => sum + Number(t.n), 0),
        review: mine.filter((t) => t.status === 'review').reduce((s, t) => s + Number(t.n), 0),
      },
      row.tokenSecretId ? `••••${hint ?? ''}` : null,
      signIns.find((s) => s.mcpServerId === row.id) ?? null,
    );
  });
}
