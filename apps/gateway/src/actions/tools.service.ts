import { createHash } from 'node:crypto';
import {
  listMcpCatalog,
  McpCallError,
  type McpCatalog as McpListed,
  type McpToolInfo,
} from '@hamnivo/adapters/mcp';
import { checkDestination, checkUrl, EgressError } from '@hamnivo/adapters/net';
import type {
  Action,
  ActionSettings,
  BuiltinTool,
  CreateMcpServerRequest,
  CreateToolRequest,
  McpServer,
  McpSyncResult,
  Run,
  ToolDefinition,
  UpdateActionSettingsRequest,
  UpdateMcpServerRequest,
  UpdateToolRequest,
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
import {
  plainText,
  type RiskClass,
  sanitizeToolSchema,
  toJsonSchema,
  toolPolicyProblems,
} from '@hamnivo/domain/actions';
import {
  authorize,
  isPermission,
  type Permission,
  type ResourceScope,
  type StaffPrincipal,
} from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, ne, or, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import { Effects } from '../commerce/effects.js';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import type { AppConfig } from '../config.js';
import { EgressService } from '../developer/egress.service.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from '../inbox/access.js';
import { KillSwitchesService } from '../runtime/kill-switches.service.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { mcpTrustedOrigins, ToolAdapters, type ToolRow } from './adapters.js';
import { ActionApprovals } from './approvals.service.js';
import { BUILTIN_KEYS, BUILTIN_TOOLS } from './builtins.js';
import { storeCatalog } from './mcp-catalog.service.js';
import { McpCredentials, McpTokenUnavailable } from './mcp-credentials.service.js';
import { dropSignIn } from './mcp-oauth.service.js';
import { serverViews } from './server-views.js';
import { supersedePending } from './supersede.js';
import { toolView } from './views.js';

type CreateTool = z.output<typeof CreateToolRequest>;
type UpdateTool = z.output<typeof UpdateToolRequest>;
type ServerRow = typeof schema.mcpServers.$inferSelect;

const POLICY_FIELDS = [
  'title',
  'description',
  'risk',
  'approver',
  'requiredPermission',
  'autopilot',
  'customerStepUp',
  'timeoutMs',
  'maxOutputBytes',
  'egressHosts',
  'amountArgument',
  'currencyArgument',
  'approvalMinutes',
] as const;

/** A tool discovered on an MCP server waits in review with the safest policy until a person looks. */
function defaultsFor(info: McpToolInfo): { risk: RiskClass; approver: 'customer' | 'staff' } {
  if (info.annotations?.readOnlyHint === true) return { risk: 'read', approver: 'staff' };
  if (info.annotations?.destructiveHint === true)
    return { risk: 'irreversible', approver: 'staff' };
  return { risk: 'write', approver: 'staff' };
}

const toolNameOf = (remote: string) =>
  remote
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64) || 'tool';

/** What a review covers; a tool without an output schema keeps the digest it had before. */
const digest = (info: McpToolInfo) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        info.name,
        info.description,
        info.inputSchema,
        info.annotations,
        ...(info.outputSchema ? [info.outputSchema] : []),
      ]),
    )
    .digest();

/**
 * The tool registry in Studio (G07, D10, HNV-11-03, board 13): tools per brand with their action
 * policy, the reviewed allowlist of tools from remote MCP servers, autopilot settings and the log
 * of AI actions. Policy changes need `tools.manage` with a fresh sign-in; each one raises the tool's
 * revision and supersedes approvals still pending for it.
 */
@Injectable()
export class ToolsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly adapters: ToolAdapters,
    private readonly switches: KillSwitchesService,
    private readonly secrets: SecretBroker,
    private readonly journal: JournalService,
    private readonly approvals: ActionApprovals,
    private readonly access: InboxAccess,
    private readonly egress: EgressService,
    private readonly credentials: McpCredentials,
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

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    target: { type: string; id: string },
    data: Record<string, unknown>,
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: target.type,
      targetId: target.id,
      outcome: 'success',
      data,
    });
  }

  private async brand(tx: TenantTx, brandPublicId: string) {
    const [brand] = await tx
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, fromPublicId('brand', brandPublicId)));
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    return brand;
  }

  private async loadTool(tx: TenantTx, publicId: string, lock = false): Promise<ToolRow> {
    const query = tx
      .select()
      .from(schema.toolDefinitions)
      .where(eq(schema.toolDefinitions.id, fromPublicId('tool', publicId)));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Tool not found.' });
    return row;
  }

  private async views(tx: TenantTx, rows: ToolRow[]): Promise<ToolDefinition[]> {
    const stopped = await this.switches.stoppedTools(
      tx,
      rows.map((r) => r.id),
    );
    return rows.map((row) => toolView(row, stopped.has(row.id)));
  }

  /** Problems with a policy, by field (a 422 lists them all). */
  private validatePolicy(
    row: Pick<ToolRow, (typeof POLICY_FIELDS)[number] | 'inputSchema' | 'source'>,
  ) {
    const fields: { path: string; message: string }[] = toolPolicyProblems({
      risk: row.risk,
      approver: row.approver,
      autopilot: row.autopilot,
      customerStepUp: row.customerStepUp,
    }).map((p) => ({ path: p.path, message: p.message }));
    if (row.requiredPermission !== null && !isPermission(row.requiredPermission)) {
      fields.push({ path: 'requiredPermission', message: 'Unknown permission' });
    }
    const parsed = sanitizeToolSchema(row.inputSchema, { trusted: row.source === 'builtin' });
    const properties = parsed.ok ? (parsed.schema.properties ?? {}) : {};
    if (
      row.amountArgument !== null &&
      !['integer', 'number'].includes(properties[row.amountArgument]?.type ?? '')
    ) {
      fields.push({ path: 'amountArgument', message: 'Must name a number argument of the tool' });
    }
    if (row.currencyArgument !== null && properties[row.currencyArgument]?.type !== 'string') {
      fields.push({ path: 'currencyArgument', message: 'Must name a text argument of the tool' });
    }
    if ((row.amountArgument === null) !== (row.currencyArgument === null)) {
      fields.push({ path: 'currencyArgument', message: 'An amount needs a currency, and back' });
    }
    if (fields.length) {
      throw new AppError('VALIDATION_FAILED', {
        detail: fields[0]?.message ?? 'The policy is not valid.',
        fields,
      });
    }
  }

  // ── Tools ───────────────────────────────────────────────────────────────────────────

  async list(principal: StaffPrincipal, brandPublicId?: string): Promise<ToolDefinition[]> {
    return this.tx(principal, async (tx) => {
      // The tools of a removed server or custom service are kept for the record of what they did,
      // and not listed.
      const found = await tx
        .select({ tool: schema.toolDefinitions })
        .from(schema.toolDefinitions)
        .leftJoin(schema.mcpServers, eq(schema.mcpServers.id, schema.toolDefinitions.mcpServerId))
        .leftJoin(
          schema.httpToolEndpoints,
          eq(schema.httpToolEndpoints.toolId, schema.toolDefinitions.id),
        )
        .leftJoin(
          schema.httpToolSources,
          eq(schema.httpToolSources.id, schema.httpToolEndpoints.sourceId),
        )
        .where(
          and(
            or(isNull(schema.mcpServers.id), ne(schema.mcpServers.status, 'deleted')),
            or(isNull(schema.httpToolSources.id), ne(schema.httpToolSources.status, 'deleted')),
            brandPublicId
              ? eq(schema.toolDefinitions.brandId, fromPublicId('brand', brandPublicId))
              : undefined,
          ),
        )
        .orderBy(schema.toolDefinitions.name);
      const rows = found.map((r) => r.tool);
      const visible = rows.filter(
        (row) =>
          this.decide(principal, 'tools.read', {
            workspaceId: row.workspaceId,
            brandId: row.brandId,
          }).allowed,
      );
      return this.views(tx, visible);
    });
  }

  builtins(): BuiltinTool[] {
    return BUILTIN_KEYS.map((key) => {
      const spec = BUILTIN_TOOLS[key];
      return {
        key,
        title: spec.title,
        description: spec.description,
        risk: spec.risk,
        approver: spec.approver,
        autopilot: spec.autopilot,
        resourceType: spec.resourceType,
        demo: spec.demo,
        available: !spec.demo || this.adapters.demoAllowed(),
      };
    });
  }

  async get(principal: StaffPrincipal, publicId: string): Promise<ToolDefinition> {
    return this.tx(principal, async (tx) => {
      const row = await this.loadTool(tx, publicId);
      enforce(
        this.decide(principal, 'tools.read', {
          workspaceId: row.workspaceId,
          brandId: row.brandId,
        }),
      );
      return (await this.views(tx, [row]))[0] as ToolDefinition;
    });
  }

  async create(principal: StaffPrincipal, input: CreateTool): Promise<ToolDefinition> {
    const spec = BUILTIN_TOOLS[input.builtin];
    if (spec.demo && !this.adapters.demoAllowed()) {
      throw new AppError('FEATURE_DISABLED', {
        detail: 'Demo tools are available in development and demo deployments only.',
      });
    }
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, input.brandId);
      enforce(
        this.decide(principal, 'tools.manage', {
          workspaceId: brand.workspaceId,
          brandId: brand.id,
        }),
      );
      const values = {
        title: input.title ?? spec.title,
        description: input.description ?? spec.description,
        risk: input.risk ?? spec.risk,
        approver: input.approver ?? spec.approver,
        requiredPermission:
          input.requiredPermission !== undefined
            ? input.requiredPermission
            : spec.requiredPermission,
        autopilot: input.autopilot ?? spec.autopilot,
        customerStepUp: input.customerStepUp ?? spec.customerStepUp,
        timeoutMs: input.timeoutMs ?? spec.timeoutMs,
        maxOutputBytes: input.maxOutputBytes ?? 16_384,
        egressHosts: input.egressHosts ?? [],
        amountArgument:
          input.amountArgument !== undefined ? input.amountArgument : spec.amountArgument,
        currencyArgument:
          input.currencyArgument !== undefined ? input.currencyArgument : spec.currencyArgument,
        approvalMinutes: input.approvalMinutes ?? null,
      };
      this.validatePolicy({ ...values, inputSchema: spec.inputSchema, source: 'builtin' });
      try {
        const [row] = await tx
          .insert(schema.toolDefinitions)
          .values({
            tenantId: principal.tenantId,
            workspaceId: brand.workspaceId,
            brandId: brand.id,
            name: spec.name,
            source: 'builtin',
            builtin: spec.key,
            inputSchema: spec.inputSchema,
            outputSchema: spec.outputSchema,
            resourceType: spec.resourceType,
            ...values,
            status: 'enabled',
            reviewedAt: this.clock(),
            reviewedBy: principal.staffMemberId,
            createdBy: principal.staffMemberId,
            updatedBy: principal.staffMemberId,
          })
          .returning();
        if (!row) throw new Error('tool insert returned nothing');
        await this.audit(
          tx,
          principal,
          'tool.created',
          { type: 'tool', id: toPublicId('tool', row.id) },
          {
            brand: input.brandId,
            builtin: spec.key,
            risk: row.risk,
            approver: row.approver,
            autopilot: row.autopilot,
          },
        );
        return (await this.views(tx, [row]))[0] as ToolDefinition;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError('VERSION_CONFLICT', { detail: 'This brand already has this tool.' });
        }
        throw error;
      }
    });
  }

  /**
   * Changes a tool's policy or status. The revision rises, and approvals still pending for the
   * tool are superseded: what was approved must be what runs.
   */
  async update(
    principal: StaffPrincipal,
    publicId: string,
    input: UpdateTool,
  ): Promise<ToolDefinition> {
    const effects = new Effects();
    const view = await this.tx(principal, async (tx) => {
      const row = await this.loadTool(tx, publicId, true);
      enforce(
        this.decide(principal, 'tools.manage', {
          workspaceId: row.workspaceId,
          brandId: row.brandId,
        }),
      );
      if (input.expectedRevision !== row.revision) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Someone changed this tool first. Reload it and apply your changes again.',
        });
      }
      const changes: Partial<ToolRow> = {};
      for (const field of POLICY_FIELDS) {
        const value = input[field];
        if (value !== undefined && JSON.stringify(value) !== JSON.stringify(row[field])) {
          (changes as Record<string, unknown>)[field] = value;
        }
      }
      if (input.status !== undefined && input.status !== row.status) changes.status = input.status;
      if (Object.keys(changes).length === 0)
        return (await this.views(tx, [row]))[0] as ToolDefinition;
      const next = { ...row, ...changes };
      this.validatePolicy(next);
      if (
        row.source === 'builtin' &&
        row.builtin &&
        BUILTIN_TOOLS[row.builtin].demo &&
        next.status === 'enabled' &&
        !this.adapters.demoAllowed()
      ) {
        throw new AppError('FEATURE_DISABLED', { detail: 'Demo tools cannot be enabled here.' });
      }
      const now = this.clock();
      const reviewed = row.status === 'review' && next.status === 'enabled';
      const [updated] = await tx
        .update(schema.toolDefinitions)
        .set({
          ...changes,
          revision: row.revision + 1,
          updatedBy: principal.staffMemberId,
          updatedAt: now,
          ...(reviewed ? { reviewedAt: now, reviewedBy: principal.staffMemberId } : {}),
        })
        .where(eq(schema.toolDefinitions.id, row.id))
        .returning();
      if (!updated) throw new Error('tool update returned nothing');
      const pending = await tx
        .update(schema.actions)
        .set({ state: 'superseded', reason: 'tool_changed', updatedAt: now })
        .where(
          and(
            eq(schema.actions.toolId, row.id),
            inArray(schema.actions.state, ['awaiting_approval', 'approved']),
          ),
        )
        .returning();
      for (const action of pending) {
        effects.add(
          principal.tenantId,
          action.conversationId,
          await this.journal.append(tx, principal.tenantId, action.conversationId, [
            {
              lane: action.approver === 'customer' ? 'customer' : 'staff',
              type: 'approval.updated',
              data: { approvalId: toPublicId('action', action.id), status: 'superseded' },
            },
          ]),
        );
      }
      await this.audit(
        tx,
        principal,
        reviewed ? 'tool.reviewed' : 'tool.updated',
        {
          type: 'tool',
          id: publicId,
        },
        {
          changed: Object.keys(changes),
          revision: updated.revision,
          superseded: pending.length,
          ...(changes.status ? { status: changes.status } : {}),
          ...(changes.risk ? { risk: changes.risk } : {}),
          ...(changes.approver ? { approver: changes.approver } : {}),
          ...(changes.autopilot !== undefined ? { autopilot: changes.autopilot } : {}),
        },
      );
      return (await this.views(tx, [updated]))[0] as ToolDefinition;
    });
    await effects.flush(this.journal);
    return view;
  }

  // ── MCP servers ─────────────────────────────────────────────────────────────────────

  async listServers(principal: StaffPrincipal, brandPublicId?: string): Promise<McpServer[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.mcpServers)
        .where(
          and(
            ne(schema.mcpServers.status, 'deleted'),
            brandPublicId
              ? eq(schema.mcpServers.brandId, fromPublicId('brand', brandPublicId))
              : undefined,
          ),
        )
        .orderBy(schema.mcpServers.createdAt);
      return serverViews(
        tx,
        rows.filter(
          (row) =>
            this.decide(principal, 'tools.read', {
              workspaceId: row.workspaceId,
              brandId: row.brandId,
            }).allowed,
        ),
      );
    });
  }

  /** The words for an address the egress guard refuses, as the field's error. */
  private refused(error: unknown): never {
    const message =
      error instanceof EgressError
        ? error.problem === 'host_not_allowed'
          ? 'This host is not on the list of allowed hosts. Add it under Allowed hosts first.'
          : error.message
        : 'Enter the server’s full HTTPS address.';
    throw new AppError('VALIDATION_FAILED', {
      detail: message,
      fields: [{ path: 'url', message }],
    });
  }

  /** The address itself, before anything else is looked at: HTTPS, no credentials, public. */
  private checkServerUrl(url: string) {
    try {
      checkUrl(url, { trustedOrigins: mcpTrustedOrigins(this.config, url) });
    } catch (error) {
      this.refused(error);
    }
  }

  /**
   * The workspace's side of an address (X05): its allowed hosts, and a name that resolves to a
   * private network is refused now. A name that does not resolve yet is accepted: the server is
   * reached through the same checks, again, when its tools are listed and called.
   */
  private async checkWorkspace(tx: TenantTx, url: string) {
    try {
      await checkDestination(
        url,
        await this.egress.policyIn(tx, mcpTrustedOrigins(this.config, url)),
      );
    } catch (error) {
      if (error instanceof EgressError && error.problem === 'unresolvable') return;
      this.refused(error);
    }
  }

  async createServer(
    principal: StaffPrincipal,
    input: z.output<typeof CreateMcpServerRequest>,
  ): Promise<McpServer> {
    this.checkServerUrl(input.url);
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, input.brandId);
      enforce(
        this.decide(principal, 'tools.manage', {
          workspaceId: brand.workspaceId,
          brandId: brand.id,
        }),
      );
      await this.checkWorkspace(tx, input.url);
      const tokenSecretId = input.token
        ? await this.secrets.storeIn(tx, principal.tenantId, {
            kind: 'mcp_token',
            label: `MCP token · ${input.label}`,
            value: input.token,
          })
        : null;
      const [removed] = await tx
        .select()
        .from(schema.mcpServers)
        .where(
          and(
            eq(schema.mcpServers.brandId, brand.id),
            eq(schema.mcpServers.url, input.url),
            eq(schema.mcpServers.status, 'deleted'),
          ),
        )
        .for('update');
      if (removed) {
        // The same address again: the record of what it did stays, and everything else is new.
        const now = this.clock();
        const [revived] = await tx
          .update(schema.mcpServers)
          .set({
            label: input.label,
            status: 'active',
            tokenSecretId,
            protocolVersion: null,
            serverName: null,
            lastSyncedAt: null,
            lastError: null,
            createdBy: principal.staffMemberId,
            createdAt: now,
            updatedAt: now,
          })
          .where(eq(schema.mcpServers.id, removed.id))
          .returning();
        if (!revived) throw new Error('server update returned nothing');
        await this.audit(
          tx,
          principal,
          'mcp_server.created',
          { type: 'mcp_server', id: toPublicId('mcpServer', revived.id) },
          {
            brand: input.brandId,
            host: new URL(input.url).hostname,
            token: tokenSecretId !== null,
            again: true,
          },
        );
        return (await serverViews(tx, [revived]))[0] as McpServer;
      }
      try {
        const [row] = await tx
          .insert(schema.mcpServers)
          .values({
            tenantId: principal.tenantId,
            workspaceId: brand.workspaceId,
            brandId: brand.id,
            label: input.label,
            url: input.url,
            tokenSecretId,
            createdBy: principal.staffMemberId,
          })
          .returning();
        if (!row) throw new Error('server insert returned nothing');
        await this.audit(
          tx,
          principal,
          'mcp_server.created',
          {
            type: 'mcp_server',
            id: toPublicId('mcpServer', row.id),
          },
          {
            brand: input.brandId,
            host: new URL(input.url).hostname,
            token: tokenSecretId !== null,
          },
        );
        return (await serverViews(tx, [row]))[0] as McpServer;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError('VERSION_CONFLICT', { detail: 'This server is already connected.' });
        }
        throw error;
      }
    });
  }

  private async loadServer(tx: TenantTx, principal: StaffPrincipal, publicId: string) {
    const [row] = await tx
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.id, fromPublicId('mcpServer', publicId)))
      .for('update');
    if (!row || row.status === 'deleted') {
      throw new AppError('NOT_FOUND', { detail: 'Server not found.' });
    }
    enforce(
      this.decide(principal, 'tools.manage', {
        workspaceId: row.workspaceId,
        brandId: row.brandId,
      }),
    );
    return row;
  }

  /** Supersedes what still waits on these tools, and tells the conversations it was in. */
  private supersedePending(
    tx: TenantTx,
    effects: Effects,
    tenantId: string,
    toolIds: string[],
    now: Date,
  ) {
    return supersedePending(tx, this.journal, effects, tenantId, toolIds, now);
  }

  async updateServer(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateMcpServerRequest>,
  ): Promise<McpServer> {
    const effects = new Effects();
    const view = await this.tx(principal, async (tx) => {
      const row = await this.loadServer(tx, principal, publicId);
      const now = this.clock();
      let url = row.url;
      let moved = false;
      if (input.url !== undefined && input.url !== row.url) {
        this.checkServerUrl(input.url);
        await this.checkWorkspace(tx, input.url);
        url = input.url;
        moved = true;
      }
      let tokenSecretId = row.tokenSecretId;
      let signedOut = false;
      if (input.token !== undefined) {
        // A token that is given or removed replaces whatever the server was signed in with.
        signedOut = (await dropSignIn(tx, this.secrets, row.id)) !== null;
        if (row.tokenSecretId) await this.secrets.revokeIn(tx, row.tokenSecretId);
        tokenSecretId = input.token
          ? await this.secrets.storeIn(tx, principal.tenantId, {
              kind: 'mcp_token',
              label: `MCP token · ${input.label ?? row.label}`,
              value: input.token,
            })
          : null;
      } else if (moved) {
        // A credential is never sent to another site, and a sign-in was made for the old address.
        const sameSite = new URL(url).origin === new URL(row.url).origin;
        signedOut = (await dropSignIn(tx, this.secrets, row.id)) !== null;
        if (row.tokenSecretId && (signedOut || !sameSite)) {
          await this.secrets.revokeIn(tx, row.tokenSecretId);
          tokenSecretId = null;
        }
      }
      let superseded = 0;
      if (moved) {
        // What the new address offers has to be looked at again: its tools go back to review.
        const tools = await tx
          .select()
          .from(schema.toolDefinitions)
          .where(eq(schema.toolDefinitions.mcpServerId, row.id))
          .for('update');
        const oldHost = new URL(row.url).hostname;
        const newHost = new URL(url).hostname;
        for (const tool of tools) {
          await tx
            .update(schema.toolDefinitions)
            .set({
              ...(tool.status === 'enabled' ? { status: 'review' as const } : {}),
              ...(oldHost !== newHost
                ? {
                    egressHosts: sql`case when ${newHost} = any(${schema.toolDefinitions.egressHosts})
                      then array_remove(${schema.toolDefinitions.egressHosts}, ${oldHost})
                      else array_append(array_remove(${schema.toolDefinitions.egressHosts}, ${oldHost}), ${newHost}) end`,
                  }
                : {}),
              revision: tool.revision + 1,
              updatedBy: principal.staffMemberId,
              updatedAt: now,
            })
            .where(eq(schema.toolDefinitions.id, tool.id));
        }
        superseded = await this.supersedePending(
          tx,
          effects,
          principal.tenantId,
          tools.map((t) => t.id),
          now,
        );
        await tx
          .delete(schema.mcpCatalogItems)
          .where(eq(schema.mcpCatalogItems.mcpServerId, row.id));
      }
      try {
        const [updated] = await tx
          .update(schema.mcpServers)
          .set({
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(moved
              ? {
                  url,
                  protocolVersion: null,
                  serverName: null,
                  lastSyncedAt: null,
                  lastError: null,
                }
              : {}),
            ...(input.token !== undefined || (moved && signedOut) ? { lastError: null } : {}),
            tokenSecretId,
            updatedAt: now,
          })
          .where(eq(schema.mcpServers.id, row.id))
          .returning();
        await this.audit(
          tx,
          principal,
          'mcp_server.updated',
          { type: 'mcp_server', id: publicId },
          {
            ...(input.label !== undefined ? { label: true } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.token !== undefined ? { token: input.token ? 'replaced' : 'removed' } : {}),
            ...(moved
              ? {
                  url: { from: new URL(row.url).hostname, to: new URL(url).hostname },
                  superseded,
                }
              : {}),
            ...(signedOut ? { signIn: 'ended' } : {}),
          },
        );
        return (await serverViews(tx, [updated ?? row]))[0] as McpServer;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError('VERSION_CONFLICT', {
            detail: 'Another server of this brand already has this address.',
          });
        }
        throw error;
      }
    });
    await effects.flush(this.journal);
    return view;
  }

  /**
   * Removes a server: its tools are turned off and no longer listed, pending requests with them
   * are superseded, its credentials are revoked and what it listed is forgotten. The record of
   * what its tools did stays, so a tool keeps its name; a server connected later gets a numbered
   * name for a tool of the same name. Connecting the same address again starts the server over.
   */
  async deleteServer(principal: StaffPrincipal, publicId: string): Promise<void> {
    const effects = new Effects();
    await this.tx(principal, async (tx) => {
      const row = await this.loadServer(tx, principal, publicId);
      const now = this.clock();
      const tools = await tx
        .select()
        .from(schema.toolDefinitions)
        .where(eq(schema.toolDefinitions.mcpServerId, row.id))
        .for('update');
      for (const tool of tools) {
        await tx
          .update(schema.toolDefinitions)
          .set({
            status: 'disabled',
            revision: tool.revision + 1,
            updatedBy: principal.staffMemberId,
            updatedAt: now,
          })
          .where(eq(schema.toolDefinitions.id, tool.id));
      }
      const superseded = await this.supersedePending(
        tx,
        effects,
        principal.tenantId,
        tools.map((t) => t.id),
        now,
      );
      await dropSignIn(tx, this.secrets, row.id);
      if (row.tokenSecretId) await this.secrets.revokeIn(tx, row.tokenSecretId);
      await tx.delete(schema.mcpCatalogItems).where(eq(schema.mcpCatalogItems.mcpServerId, row.id));
      await tx
        .update(schema.mcpServers)
        .set({ status: 'deleted', tokenSecretId: null, lastError: null, updatedAt: now })
        .where(eq(schema.mcpServers.id, row.id));
      await this.audit(
        tx,
        principal,
        'mcp_server.deleted',
        { type: 'mcp_server', id: publicId },
        { host: new URL(row.url).hostname, tools: tools.length, superseded },
      );
    });
    await effects.flush(this.journal);
  }

  /**
   * Lists a server with its token. A token the server refuses is renewed once (an OAuth sign-in
   * has a refresh token) and the listing is asked for again.
   */
  private async listSignedIn(
    tenantId: string,
    row: ServerRow,
    policy: Awaited<ReturnType<EgressService['policyIn']>>,
  ): Promise<McpListed> {
    const endpoint = (token: string | null) => ({
      url: row.url,
      token,
      trustedOrigins: policy.trustedOrigins ?? [],
      ...(policy.resolve ? { resolve: policy.resolve } : {}),
      timeoutMs: 10_000,
    });
    const token = await this.credentials.bearer(tenantId, row.id);
    try {
      return await listMcpCatalog(endpoint(token));
    } catch (error) {
      if (!(error instanceof McpCallError) || error.kind !== 'auth' || token === null) throw error;
      const renewed = await this.credentials.bearer(tenantId, row.id, { rejected: token });
      if (renewed === null || renewed === token) throw error;
      return await listMcpCatalog(endpoint(renewed));
    }
  }

  /**
   * Lists the server's tools. New tools and tools whose listing changed wait in review (nothing
   * can call them); tools the server no longer lists are disabled. What the server says is kept as
   * untrusted text and never becomes the description the model sees.
   */
  async syncServer(principal: StaffPrincipal, publicId: string): Promise<McpSyncResult> {
    const loaded = await this.tx(principal, async (tx) => {
      const row = await this.loadServer(tx, principal, publicId);
      // The workspace's allowed hosts apply to MCP servers like to every request made for it.
      const policy = await this.egress.policyIn(tx, mcpTrustedOrigins(this.config, row.url));
      return { row, policy };
    });
    const { row, policy } = loaded;
    let listing: McpListed;
    try {
      checkUrl(row.url, policy);
      listing = await this.listSignedIn(principal.tenantId, row, policy);
    } catch (error) {
      const kind =
        error instanceof EgressError
          ? 'egress'
          : error instanceof Error && 'kind' in error
            ? String((error as { kind: string }).kind)
            : null;
      const message =
        error instanceof McpTokenUnavailable
          ? error.kind === 'reconnect'
            ? 'The saved sign-in no longer works. Sign in again.'
            : 'The sign-in service did not answer. Try again in a moment.'
          : kind === 'auth'
            ? 'The server did not accept the sign-in or token. Sign in again, or enter a new token.'
            : kind
              ? `The server could not be listed (${kind}).`
              : 'The server could not be listed.';
      await this.tx(principal, (tx) =>
        tx
          .update(schema.mcpServers)
          .set({ lastError: message, updatedAt: this.clock() })
          .where(eq(schema.mcpServers.id, row.id)),
      );
      throw new AppError('PROVIDER_UNAVAILABLE', { detail: message, retryAfter: 5 });
    }
    return this.tx(principal, async (tx) => {
      const host = new URL(row.url).hostname;
      const existing = await tx
        .select()
        .from(schema.toolDefinitions)
        .where(eq(schema.toolDefinitions.mcpServerId, row.id))
        .for('update');
      const now = this.clock();
      // A tool of a removed server keeps its name for the record, so a new tool of the same name
      // takes a numbered one instead of being turned away.
      const named = await tx
        .select({ name: schema.toolDefinitions.name, server: schema.mcpServers.status })
        .from(schema.toolDefinitions)
        .leftJoin(schema.mcpServers, eq(schema.mcpServers.id, schema.toolDefinitions.mcpServerId))
        .where(eq(schema.toolDefinitions.brandId, row.brandId));
      const taken = new Set(named.map((n) => n.name));
      const setAside = new Set(named.filter((n) => n.server === 'deleted').map((n) => n.name));
      const nameFor = (remoteName: string) => {
        const wanted = toolNameOf(remoteName);
        if (!setAside.has(wanted)) return wanted;
        for (let n = 2; ; n += 1) {
          const next = `${wanted.slice(0, 58)}_${n}`;
          if (!taken.has(next)) return next;
        }
      };
      const added: string[] = [];
      const changed: string[] = [];
      const removed: string[] = [];
      const skipped: { name: string; reason: string }[] = [];
      const seen = new Set<string>();
      for (const info of listing.tools) {
        const remoteName = info.name.slice(0, 128);
        const parsed = sanitizeToolSchema(info.inputSchema, { trusted: false });
        if (!parsed.ok) {
          skipped.push({ name: plainText(remoteName, 64), reason: parsed.problem });
          continue;
        }
        // A promise about results that Hamnivo cannot check is refused like unusable arguments.
        const output = info.outputSchema
          ? sanitizeToolSchema(info.outputSchema, { trusted: false })
          : null;
        if (output && !output.ok) {
          skipped.push({
            name: plainText(remoteName, 64),
            reason: `Output schema: ${output.problem}`,
          });
          continue;
        }
        // Kept as standard JSON Schema, so it reads back exactly (nullable fields included).
        const outputSchema = output?.ok ? toJsonSchema(output.schema) : null;
        seen.add(remoteName);
        const remoteDescription = info.description ? plainText(info.description, 2000) : null;
        const hash = digest(info);
        const current = existing.find((t) => t.remoteName === remoteName);
        if (!current) {
          const defaults = defaultsFor(info);
          const title = plainText(info.title ?? remoteName, 120) || remoteName;
          const name = nameFor(remoteName);
          taken.add(name);
          const [inserted] = await tx
            .insert(schema.toolDefinitions)
            .values({
              tenantId: principal.tenantId,
              workspaceId: row.workspaceId,
              brandId: row.brandId,
              name,
              title,
              description: `${title} (from ${row.label}). Written by Hamnivo until a person reviews it.`,
              remoteDescription,
              source: 'mcp',
              mcpServerId: row.id,
              remoteName,
              remoteDigest: hash,
              inputSchema: parsed.schema as unknown as Record<string, unknown>,
              outputSchema,
              ...defaults,
              autopilot: false,
              egressHosts: [host],
              status: 'review',
              createdBy: principal.staffMemberId,
              updatedBy: principal.staffMemberId,
            })
            .onConflictDoNothing()
            .returning();
          if (inserted) added.push(inserted.name);
          else
            skipped.push({
              name: plainText(remoteName, 64),
              reason: 'Another tool has this name.',
            });
        } else if (!current.remoteDigest?.equals(hash) || current.status === 'disabled') {
          // A changed listing goes back to review: what was reviewed is no longer what runs.
          await tx
            .update(schema.toolDefinitions)
            .set({
              remoteDescription,
              remoteDigest: hash,
              inputSchema: parsed.schema as unknown as Record<string, unknown>,
              outputSchema,
              status: 'review',
              revision: current.revision + 1,
              updatedBy: principal.staffMemberId,
              updatedAt: now,
            })
            .where(eq(schema.toolDefinitions.id, current.id));
          changed.push(current.name);
        }
      }
      for (const tool of existing) {
        if (!seen.has(tool.remoteName ?? '') && tool.status !== 'disabled') {
          await tx
            .update(schema.toolDefinitions)
            .set({ status: 'disabled', revision: tool.revision + 1, updatedAt: now })
            .where(eq(schema.toolDefinitions.id, tool.id));
          removed.push(tool.name);
        }
      }
      if (changed.length + removed.length > 0) {
        const ids = existing
          .filter((t) => changed.includes(t.name) || removed.includes(t.name))
          .map((t) => t.id);
        await tx
          .update(schema.actions)
          .set({ state: 'superseded', reason: 'tool_changed', updatedAt: now })
          .where(
            and(
              inArray(schema.actions.toolId, ids),
              inArray(schema.actions.state, ['awaiting_approval', 'approved']),
            ),
          );
      }
      const [updated] = await tx
        .update(schema.mcpServers)
        .set({
          protocolVersion: listing.protocolVersion?.slice(0, 40) ?? null,
          serverName: listing.serverName ? plainText(listing.serverName, 120) : null,
          lastSyncedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(schema.mcpServers.id, row.id))
        .returning();
      const offered = await storeCatalog(tx, principal.tenantId, row.id, listing, now);
      await this.audit(
        tx,
        principal,
        'mcp_server.synced',
        { type: 'mcp_server', id: publicId },
        {
          added,
          changed,
          removed,
          skipped: skipped.length,
          resources: offered.resources,
          prompts: offered.prompts,
        },
      );
      return {
        server: (await serverViews(tx, [updated ?? row]))[0] as McpServer,
        added,
        changed,
        removed,
        skipped,
      };
    });
  }

  // ── Settings and the action log ─────────────────────────────────────────────────────

  async settings(principal: StaffPrincipal): Promise<ActionSettings> {
    return this.tx(principal, async (tx) => {
      const [row] = await tx.select().from(schema.actionSettings);
      return {
        autopilotEnabled: row?.autopilotEnabled ?? true,
        dailyAutopilotLimit: row?.dailyAutopilotLimit ?? 200,
        updatedAt: row ? row.updatedAt.toISOString() : null,
      };
    });
  }

  async updateSettings(
    principal: StaffPrincipal,
    input: z.output<typeof UpdateActionSettingsRequest>,
  ): Promise<ActionSettings> {
    return this.tx(principal, async (tx) => {
      enforce(this.decide(principal, 'tools.manage', {}));
      await tx
        .insert(schema.actionSettings)
        .values({ tenantId: principal.tenantId })
        .onConflictDoNothing();
      const [row] = await tx
        .update(schema.actionSettings)
        .set({
          ...(input.autopilotEnabled !== undefined
            ? { autopilotEnabled: input.autopilotEnabled }
            : {}),
          ...(input.dailyAutopilotLimit !== undefined
            ? { dailyAutopilotLimit: input.dailyAutopilotLimit }
            : {}),
          updatedBy: principal.staffMemberId,
          updatedAt: this.clock(),
        })
        .returning();
      await this.audit(
        tx,
        principal,
        'action_settings.updated',
        {
          type: 'tenant',
          id: toPublicId('tenant', principal.tenantId),
        },
        { ...input },
      );
      return {
        autopilotEnabled: row?.autopilotEnabled ?? true,
        dailyAutopilotLimit: row?.dailyAutopilotLimit ?? 200,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    });
  }

  async listActions(
    principal: StaffPrincipal,
    query: {
      brandId?: string | undefined;
      conversationId?: string | undefined;
      toolId?: string | undefined;
      state?: Action['state'] | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ): Promise<{ items: Action[]; nextCursor: string | null }> {
    return this.tx(principal, async (tx) => {
      const filters: SQL[] = [];
      if (query.conversationId) {
        filters.push(
          eq(schema.actions.conversationId, fromPublicId('conversation', query.conversationId)),
        );
      }
      if (query.toolId) filters.push(eq(schema.actions.toolId, fromPublicId('tool', query.toolId)));
      if (query.brandId) {
        filters.push(eq(schema.toolDefinitions.brandId, fromPublicId('brand', query.brandId)));
      }
      if (query.state) filters.push(eq(schema.actions.state, query.state));
      if (query.cursor) filters.push(lt(schema.actions.id, fromPublicId('action', query.cursor)));
      const rows = await tx
        .select({
          action: schema.actions,
          workspaceId: schema.toolDefinitions.workspaceId,
          brandId: schema.toolDefinitions.brandId,
        })
        .from(schema.actions)
        .innerJoin(schema.toolDefinitions, eq(schema.toolDefinitions.id, schema.actions.toolId))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(schema.actions.id))
        .limit(query.limit + 1);
      const visible = rows.filter(
        (r) =>
          this.decide(principal, 'tools.read', { workspaceId: r.workspaceId, brandId: r.brandId })
            .allowed,
      );
      const page = visible.slice(0, query.limit);
      const items: Action[] = [];
      for (const r of page) items.push(await this.approvals.view(tx, r.action, true));
      const last = page.at(-1);
      return {
        items,
        nextCursor: rows.length > query.limit && last ? toPublicId('action', last.action.id) : null,
      };
    });
  }

  /**
   * Asks a running AI run to stop (conversations.takeover on its conversation). The run cancels
   * its tool calls in flight; a change already sent is reconciled, never cancelled blindly.
   */
  async cancelRun(principal: StaffPrincipal, runPublicId: string): Promise<Run> {
    return this.access.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, fromPublicId('run', runPublicId)))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Run not found.' });
      await this.access.authorized(
        tx,
        principal,
        toPublicId('conversation', row.conversationId),
        'conversations.takeover',
      );
      const now = this.clock();
      const [updated] =
        row.state === 'running' && !row.cancelRequestedAt
          ? await tx
              .update(schema.runs)
              .set({ cancelRequestedAt: now, cancelRequestedBy: principal.staffMemberId })
              .where(eq(schema.runs.id, row.id))
              .returning()
          : [row];
      await this.audit(
        tx,
        principal,
        'ai.run.cancel_requested',
        { type: 'run', id: runPublicId },
        {
          state: row.state,
        },
      );
      const run = updated ?? row;
      return {
        id: runPublicId,
        conversationId: toPublicId('conversation', run.conversationId),
        agentId: run.agentId ? toPublicId('agent', run.agentId) : null,
        agentVersion: null,
        kind: run.kind,
        state: run.state,
        outcome: run.outcome,
        provider: run.provider,
        modelId: run.modelId,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        latencyMs: run.latencyMs,
        errorKind: run.errorKind,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
      };
    });
  }
}
