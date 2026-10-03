import type { McpCatalog as McpListed } from '@hamnivo/adapters/mcp';
import type {
  McpCatalog,
  McpCatalogPrompt,
  McpCatalogResource,
  UpdateMcpResourceRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { plainText } from '@hamnivo/domain/actions';
import {
  authorize,
  type Permission,
  type ResourceScope,
  type StaffPrincipal,
} from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, notInArray } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { iso } from '../common/views.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type ItemRow = typeof schema.mcpCatalogItems.$inferSelect;

const resourceView = (row: ItemRow): McpCatalogResource => ({
  id: toPublicId('mcpItem', row.id),
  uri: row.key,
  name: row.name,
  title: row.title,
  description: row.description,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  aiReadable: row.aiReadable,
});

const promptView = (row: ItemRow): McpCatalogPrompt => ({
  id: toPublicId('mcpItem', row.id),
  name: row.name,
  title: row.title,
  description: row.description,
  arguments: (row.arguments ?? []).map((a) => ({
    name: String(a.name ?? ''),
    description: typeof a.description === 'string' ? a.description : null,
    required: a.required === true,
  })),
});

const short = (value: string | null | undefined, max: number): string | null => {
  const text = value ? plainText(value, max) : '';
  return text === '' ? null : text;
};

/**
 * Keeps what a server listed besides its tools, from its last sync. A list the server could not
 * give this time (`null`) leaves what was stored. A resource keeps its "agents may read it" switch
 * across syncs; one the server no longer lists is dropped. Everything the server says is
 * shortened and stripped of control characters, and shown as quoted text.
 */
export async function storeCatalog(
  tx: TenantTx,
  tenantId: string,
  serverId: string,
  listed: Pick<McpListed, 'resources' | 'prompts'>,
  now: Date,
): Promise<{ resources: number; prompts: number }> {
  const t = schema.mcpCatalogItems;
  const sync = async (
    kind: 'resource' | 'prompt',
    items: { key: string; values: Partial<typeof t.$inferInsert> & { name: string } }[] | null,
  ) => {
    if (items === null) return;
    for (const item of items) {
      await tx
        .insert(t)
        .values({
          tenantId,
          mcpServerId: serverId,
          kind,
          key: item.key,
          listedAt: now,
          ...item.values,
        })
        .onConflictDoUpdate({
          target: [t.tenantId, t.mcpServerId, t.kind, t.key],
          set: { ...item.values, listedAt: now, updatedAt: now },
        });
    }
    const keys = items.map((item) => item.key);
    await tx
      .delete(t)
      .where(
        and(
          eq(t.mcpServerId, serverId),
          eq(t.kind, kind),
          ...(keys.length ? [notInArray(t.key, keys)] : []),
        ),
      );
  };
  await sync(
    'resource',
    listed.resources === null
      ? null
      : listed.resources.map((r) => ({
          key: r.uri.slice(0, 2000),
          values: {
            name: plainText(r.name, 160) || plainText(r.uri, 160),
            title: short(r.title, 160),
            description: short(r.description, 1000),
            mimeType: short(r.mimeType, 100),
            sizeBytes:
              r.size !== null && Number.isSafeInteger(r.size) && r.size >= 0 && r.size < 2 ** 31
                ? r.size
                : null,
          },
        })),
  );
  await sync(
    'prompt',
    listed.prompts === null
      ? null
      : listed.prompts.map((p) => ({
          key: p.name.slice(0, 200),
          values: {
            name: plainText(p.name, 160),
            title: short(p.title, 160),
            description: short(p.description, 1000),
            arguments: p.arguments.slice(0, 20).map((a) => ({
              name: plainText(a.name, 80),
              description: short(a.description, 300),
              required: a.required,
            })),
          },
        })),
  );
  return {
    resources: listed.resources?.length ?? 0,
    prompts: listed.prompts?.length ?? 0,
  };
}

/**
 * The resources and prompts of an MCP server, as the last sync listed them (D10). They are text
 * from another system, shown quoted. Agents with the "Read a resource" tool may read the
 * resources a person switched on, and no others; prompts are listed for people to see and are not
 * given to agents.
 */
@Injectable()
export class McpCatalogService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private decide(principal: StaffPrincipal, permission: Permission, resource: ResourceScope) {
    return authorize(principal, permission, resource, {
      now: this.clock(),
      stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
    });
  }

  private async server(tx: TenantTx, publicId: string) {
    const [row] = await tx
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.id, fromPublicId('mcpServer', publicId)));
    if (!row || row.status === 'deleted') {
      throw new AppError('NOT_FOUND', { detail: 'Server not found.' });
    }
    return row;
  }

  async get(principal: StaffPrincipal, serverPublicId: string): Promise<McpCatalog> {
    return this.tx(principal, async (tx) => {
      const server = await this.server(tx, serverPublicId);
      enforce(
        this.decide(principal, 'tools.read', {
          workspaceId: server.workspaceId,
          brandId: server.brandId,
        }),
      );
      const rows = await tx
        .select()
        .from(schema.mcpCatalogItems)
        .where(eq(schema.mcpCatalogItems.mcpServerId, server.id))
        .orderBy(schema.mcpCatalogItems.name);
      return {
        resources: rows.filter((r) => r.kind === 'resource').map(resourceView),
        prompts: rows.filter((r) => r.kind === 'prompt').map(promptView),
        syncedAt: iso(server.lastSyncedAt),
      };
    });
  }

  async setReadable(
    principal: StaffPrincipal,
    serverPublicId: string,
    itemPublicId: string,
    input: z.output<typeof UpdateMcpResourceRequest>,
  ): Promise<McpCatalogResource> {
    return this.tx(principal, async (tx) => {
      const server = await this.server(tx, serverPublicId);
      enforce(
        this.decide(principal, 'tools.manage', {
          workspaceId: server.workspaceId,
          brandId: server.brandId,
        }),
      );
      const [item] = await tx
        .select()
        .from(schema.mcpCatalogItems)
        .where(
          and(
            eq(schema.mcpCatalogItems.id, fromPublicId('mcpItem', itemPublicId)),
            eq(schema.mcpCatalogItems.mcpServerId, server.id),
            eq(schema.mcpCatalogItems.kind, 'resource'),
          ),
        )
        .for('update');
      if (!item) throw new AppError('NOT_FOUND', { detail: 'Resource not found.' });
      if (item.aiReadable === input.aiReadable) return resourceView(item);
      const [updated] = await tx
        .update(schema.mcpCatalogItems)
        .set({ aiReadable: input.aiReadable, updatedAt: this.clock() })
        .where(eq(schema.mcpCatalogItems.id, item.id))
        .returning();
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'mcp_resource.updated',
        targetType: 'mcp_server',
        targetId: serverPublicId,
        outcome: 'success',
        data: { resource: itemPublicId, aiReadable: input.aiReadable },
      });
      return resourceView(updated ?? item);
    });
  }
}
