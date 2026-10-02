import { createHash } from 'node:crypto';
import { checkEgressUrl, EgressError } from '@hamnivo/adapters/egress';
import { listMcpTools, type McpToolInfo } from '@hamnivo/adapters/mcp';
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
import { and, count, desc, eq, inArray, lt, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import { Effects } from '../commerce/effects.js';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from '../inbox/access.js';
import { KillSwitchesService } from '../runtime/kill-switches.service.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { ToolAdapters, type ToolRow } from './adapters.js';
import { ActionApprovals } from './approvals.service.js';
import { BUILTIN_KEYS, BUILTIN_TOOLS } from './builtins.js';
import { serverView, toolView } from './views.js';

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
      const rows = await tx
        .select()
        .from(schema.toolDefinitions)
        .where(
          brandPublicId
            ? eq(schema.toolDefinitions.brandId, fromPublicId('brand', brandPublicId))
            : undefined,
        )
        .orderBy(schema.toolDefinitions.name);
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

  private async serverViews(tx: TenantTx, rows: ServerRow[]): Promise<McpServer[]> {
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
      );
    });
  }

  async listServers(principal: StaffPrincipal, brandPublicId?: string): Promise<McpServer[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.mcpServers)
        .where(
          brandPublicId
            ? eq(schema.mcpServers.brandId, fromPublicId('brand', brandPublicId))
            : undefined,
        )
        .orderBy(schema.mcpServers.createdAt);
      return this.serverViews(
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

  private checkUrl(url: string) {
    try {
      const parsed = new URL(url);
      checkEgressUrl(parsed, {
        allowedHosts: [parsed.hostname],
        allowPrivate: this.config.TOOLS_EGRESS_ALLOW_PRIVATE,
      });
    } catch (error) {
      const message =
        error instanceof EgressError ? error.message : 'Enter the server’s full HTTPS address.';
      throw new AppError('VALIDATION_FAILED', {
        detail: message,
        fields: [{ path: 'url', message }],
      });
    }
  }

  async createServer(
    principal: StaffPrincipal,
    input: z.output<typeof CreateMcpServerRequest>,
  ): Promise<McpServer> {
    this.checkUrl(input.url);
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, input.brandId);
      enforce(
        this.decide(principal, 'tools.manage', {
          workspaceId: brand.workspaceId,
          brandId: brand.id,
        }),
      );
      const tokenSecretId = input.token
        ? await this.secrets.storeIn(tx, principal.tenantId, {
            kind: 'mcp_token',
            label: `MCP token · ${input.label}`,
            value: input.token,
          })
        : null;
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
        return (await this.serverViews(tx, [row]))[0] as McpServer;
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
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Server not found.' });
    enforce(
      this.decide(principal, 'tools.manage', {
        workspaceId: row.workspaceId,
        brandId: row.brandId,
      }),
    );
    return row;
  }

  async updateServer(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateMcpServerRequest>,
  ): Promise<McpServer> {
    return this.tx(principal, async (tx) => {
      const row = await this.loadServer(tx, principal, publicId);
      let tokenSecretId = row.tokenSecretId;
      if (input.token !== undefined) {
        if (row.tokenSecretId) {
          await tx
            .update(schema.secrets)
            .set({ revokedAt: this.clock() })
            .where(eq(schema.secrets.id, row.tokenSecretId));
        }
        tokenSecretId = input.token
          ? await this.secrets.storeIn(tx, principal.tenantId, {
              kind: 'mcp_token',
              label: `MCP token · ${input.label ?? row.label}`,
              value: input.token,
            })
          : null;
      }
      const [updated] = await tx
        .update(schema.mcpServers)
        .set({
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          tokenSecretId,
          updatedAt: this.clock(),
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
        },
      );
      return (await this.serverViews(tx, [updated ?? row]))[0] as McpServer;
    });
  }

  /**
   * Lists the server's tools. New tools and tools whose listing changed wait in review (nothing
   * can call them); tools the server no longer lists are disabled. What the server says is kept as
   * untrusted text and never becomes the description the model sees.
   */
  async syncServer(principal: StaffPrincipal, publicId: string): Promise<McpSyncResult> {
    const loaded = await this.tx(principal, async (tx) => {
      const row = await this.loadServer(tx, principal, publicId);
      const token = row.tokenSecretId
        ? await this.secrets.reveal(tx, principal.tenantId, row.tokenSecretId)
        : null;
      return { row, token };
    });
    const { row } = loaded;
    let listing: Awaited<ReturnType<typeof listMcpTools>>;
    try {
      listing = await listMcpTools({
        url: row.url,
        token: loaded.token,
        allowPrivate: this.config.TOOLS_EGRESS_ALLOW_PRIVATE,
        timeoutMs: 10_000,
      });
    } catch (error) {
      const message =
        error instanceof Error && 'kind' in error
          ? `The server could not be listed (${String((error as { kind: string }).kind)}).`
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
          const [inserted] = await tx
            .insert(schema.toolDefinitions)
            .values({
              tenantId: principal.tenantId,
              workspaceId: row.workspaceId,
              brandId: row.brandId,
              name: toolNameOf(remoteName),
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
        },
      );
      return {
        server: (await this.serverViews(tx, [updated ?? row]))[0] as McpServer,
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
