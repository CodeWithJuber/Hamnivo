import { safeRequest } from '@hamnivo/adapters/net';
import {
  type AddHttpEndpointsRequest,
  type CreateHttpSourceRequest,
  HTTP_SPEC_MAX_CHARS,
  type HttpEndpointInput,
  type HttpOpenApiImport,
  type HttpSpecPreview,
  type HttpToolAuthInput,
  type HttpToolSource,
  type PreviewHttpSpecRequest,
  type UpdateHttpEndpointRequest,
  type UpdateHttpSourceRequest,
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
import { plainText, type RiskClass } from '@hamnivo/domain/actions';
import {
  authorize,
  type Permission,
  type ResourceScope,
  type StaffPrincipal,
} from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../../authority/journal.service.js';
import { Effects } from '../../commerce/effects.js';
import { AppError } from '../../common/app-error.js';
import { isUniqueViolation } from '../../common/pg-error.js';
import type { AppConfig } from '../../config.js';
import { EgressService } from '../../developer/egress.service.js';
import { enforce } from '../../identity/staff.guard.js';
import { SecretBroker } from '../../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../../tokens.js';
import { mcpTrustedOrigins } from '../mcp-origins.js';
import { supersedePending } from '../supersede.js';
import {
  type Assembled,
  assemble,
  baseToolName,
  credentialHeaderAllowed,
  defaultRisk,
  freeName,
  HEADER_NAME,
  hasControl,
  type ToolArgument,
} from './definition.js';
import { checkServiceAddress, checkWorkspaceSide, refused } from './network.js';
import { type ParsedOperation, type ParsedSpec, parseOpenApi, SpecProblem } from './openapi.js';
import { type SourceRow, sourceViews } from './views.js';

type Create = z.output<typeof CreateHttpSourceRequest>;
type AddEndpoints = z.output<typeof AddHttpEndpointsRequest>;
type UpdateSource = z.output<typeof UpdateHttpSourceRequest>;
type UpdateEndpoint = z.output<typeof UpdateHttpEndpointRequest>;
type Preview = z.output<typeof PreviewHttpSpecRequest>;
type Import = z.output<typeof HttpOpenApiImport>;
type Endpoint = z.output<typeof HttpEndpointInput>;
type Auth = z.output<typeof HttpToolAuthInput>;

/** A tool as it is about to be stored. */
interface Prepared {
  /** `GET /orders`: the route, to tell tools of one service apart. */
  key: string;
  /** The operation's id in an imported description; none for a request written by hand. */
  operationId: string | null;
  title: string;
  /** What the AI is told the tool does. */
  description: string;
  /** What the imported description said: untrusted, shown quoted, never sent as is. */
  remoteDescription: string | null;
  baseName: string;
  risk: RiskClass;
  assembled: Assembled;
  digest: Buffer | null;
}

const SECRET_KIND = 'http_tool_credential';
const SPEC_ACCEPT = 'application/json, application/yaml;q=0.9, text/yaml;q=0.9, text/plain;q=0.5';
const MAX_REDIRECTS = 3;

const invalid = (path: string, message: string): never => {
  throw new AppError('VALIDATION_FAILED', { detail: message, fields: [{ path, message }] });
};

/**
 * Custom HTTP tools in Studio (D10): a service with an address and a credential, and tools that
 * are requests to it, imported from an OpenAPI description or written by hand. Every tool is an
 * ordinary tool of the brand (`source = 'http'`): it starts in review with the safest policy, goes
 * through the same approvals, budgets and kill switches, and reaches only its service's host.
 * Credentials live in the secret broker and are never returned; what an imported description says
 * is kept as untrusted text beside Hamnivo's own description of the tool.
 */
@Injectable()
export class HttpToolsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
    private readonly journal: JournalService,
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
    sourceId: string,
    data: Record<string, unknown>,
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'http_tool_source',
      targetId: toPublicId('httpSource', sourceId),
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

  /** A service of the brand that is not removed, locked for a change, for someone who may manage it. */
  private async loadSource(tx: TenantTx, principal: StaffPrincipal, publicId: string) {
    const [row] = await tx
      .select()
      .from(schema.httpToolSources)
      .where(eq(schema.httpToolSources.id, fromPublicId('httpSource', publicId)))
      .for('update');
    if (!row || row.status === 'deleted') {
      throw new AppError('NOT_FOUND', { detail: 'Service not found.' });
    }
    enforce(
      this.decide(principal, 'tools.manage', {
        workspaceId: row.workspaceId,
        brandId: row.brandId,
      }),
    );
    return row;
  }

  /** The tools of a service with their endpoints, locked for a change. */
  private toolsOf(tx: TenantTx, sourceId: string) {
    return tx
      .select({ tool: schema.toolDefinitions, endpoint: schema.httpToolEndpoints })
      .from(schema.httpToolEndpoints)
      .innerJoin(
        schema.toolDefinitions,
        eq(schema.toolDefinitions.id, schema.httpToolEndpoints.toolId),
      )
      .where(eq(schema.httpToolEndpoints.sourceId, sourceId))
      .for('update', { of: schema.toolDefinitions });
  }

  private async routesOf(tx: TenantTx, sourceId: string): Promise<Set<string>> {
    const rows = await tx
      .select({
        method: schema.httpToolEndpoints.method,
        path: schema.httpToolEndpoints.pathTemplate,
      })
      .from(schema.httpToolEndpoints)
      .where(eq(schema.httpToolEndpoints.sourceId, sourceId));
    return new Set(rows.map((row) => `${row.method} ${row.path}`));
  }

  // ── Reading ─────────────────────────────────────────────────────────────────────────

  async list(principal: StaffPrincipal, brandPublicId?: string): Promise<HttpToolSource[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.httpToolSources)
        .where(
          and(
            ne(schema.httpToolSources.status, 'deleted'),
            brandPublicId
              ? eq(schema.httpToolSources.brandId, fromPublicId('brand', brandPublicId))
              : undefined,
          ),
        )
        .orderBy(asc(schema.httpToolSources.createdAt), asc(schema.httpToolSources.id));
      return sourceViews(
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

  /** The text of a description, pasted or fetched from its address through the egress guard. */
  private async specText(
    principal: StaffPrincipal,
    input: { spec?: string | undefined; specUrl?: string | undefined },
  ): Promise<{ text: string; address: string | undefined }> {
    if (input.spec !== undefined) return { text: input.spec, address: undefined };
    const address = input.specUrl as string;
    let current = address;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const policy = await this.tx(principal, (tx) =>
        this.egress.policyIn(tx, mcpTrustedOrigins(this.config, current)),
      );
      let response: Awaited<ReturnType<typeof safeRequest>>;
      try {
        response = await safeRequest(
          {
            url: current,
            headers: { accept: SPEC_ACCEPT },
            timeoutMs: 10_000,
            maxResponseBytes: HTTP_SPEC_MAX_CHARS + 1,
          },
          policy,
        );
      } catch (error) {
        return refused(error, 'specUrl');
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        if (typeof location !== 'string') break;
        try {
          current = new URL(location, current).href;
        } catch {
          break;
        }
        continue;
      }
      if (response.status !== 200) {
        return invalid('specUrl', `The address answered ${response.status}, not the description.`);
      }
      if (response.truncated || response.body.length > HTTP_SPEC_MAX_CHARS) {
        return invalid(
          'specUrl',
          'The description is too large. Remove the operations you do not need, or write the requests by hand.',
        );
      }
      return { text: response.body.toString('utf8'), address };
    }
    return invalid('specUrl', 'The address sends you on to too many other addresses.');
  }

  private parse(text: string, address: string | undefined): ParsedSpec {
    try {
      return parseOpenApi(text, address ? { specUrl: address } : {});
    } catch (error) {
      if (error instanceof SpecProblem) return invalid(address ? 'specUrl' : 'spec', error.message);
      throw error;
    }
  }

  /** Reads a description and lists what could become tools. Nothing is saved. */
  async preview(principal: StaffPrincipal, input: Preview): Promise<HttpSpecPreview> {
    const known = input.sourceId
      ? await this.tx(principal, async (tx) =>
          this.routesOf(tx, (await this.loadSource(tx, principal, input.sourceId as string)).id),
        )
      : new Set<string>();
    const { text, address } = await this.specText(principal, input);
    const parsed = this.parse(text, address);
    return {
      openapi: parsed.openapi,
      title: parsed.title,
      version: parsed.version,
      hash: parsed.hash,
      servers: parsed.servers,
      auth: parsed.auth,
      operations: parsed.operations.map((operation) => ({
        key: operation.key,
        method: operation.method,
        path: operation.path,
        title: operation.title,
        summary: operation.remoteDescription ? plainText(operation.remoteDescription, 400) : null,
        toolName: operation.baseName,
        risk: operation.risk,
        arguments: operation.arguments,
        notes: operation.notes,
        imported: known.has(operation.key),
      })),
      skipped: parsed.skipped.slice(0, 300),
    };
  }

  // ── Tools from what a person gave ───────────────────────────────────────────────────

  private fromOperation(operation: ParsedOperation, sourceName: string): Prepared {
    return {
      key: operation.key,
      operationId: operation.operationId,
      title: operation.title,
      description: `${operation.title} (from ${sourceName}). Written by Hamnivo until a person reviews it.`,
      remoteDescription: operation.remoteDescription,
      baseName: operation.baseName,
      risk: operation.risk,
      assembled: operation.assembled,
      digest: operation.digest,
    };
  }

  /** A request written by hand, checked like every imported one. */
  private fromEndpoint(input: Endpoint, prefix = 'endpoint.'): Prepared {
    const args: ToolArgument[] = input.arguments.map((argument) => ({
      name: argument.name,
      in: argument.in,
      key: argument.key ?? argument.name,
      required: argument.required,
      schema: {
        type: argument.type,
        ...(argument.description ? { description: plainText(argument.description, 300) } : {}),
      },
    }));
    const assembled = assemble({ method: input.method, path: input.path, arguments: args });
    if (!assembled.ok) return invalid(`${prefix}${assembled.field}`, assembled.problem);
    // Text of nothing but invisible characters is no text.
    const title = plainText(input.title, 120);
    const description = plainText(input.description, 1000);
    if (title === '') return invalid(`${prefix}title`, 'Give the tool a name.');
    if (description === '') return invalid(`${prefix}description`, 'Say what the tool does.');
    return {
      key: `${input.method} ${input.path}`,
      operationId: null,
      title,
      description,
      remoteDescription: null,
      // A name from the title; a title in a script without Latin letters falls back to the path.
      baseName: baseToolName(title, input.method, input.path),
      risk: input.risk ?? defaultRisk(input.method),
      assembled: assembled.value,
      digest: null,
    };
  }

  /** The chosen operations of a description, as tools; operations a service has already are left. */
  private async fromImport(
    principal: StaffPrincipal,
    input: Import,
    sourceName: string,
    have: ReadonlySet<string>,
  ): Promise<{ parsed: ParsedSpec; tools: Prepared[] }> {
    const { text, address } = await this.specText(principal, input);
    const parsed = this.parse(text, address);
    if (input.specHash !== undefined && parsed.hash !== input.specHash) {
      throw new AppError('VERSION_CONFLICT', {
        detail: 'The description changed since you read it. Read it again and check the list.',
      });
    }
    const byKey = new Map(parsed.operations.map((operation) => [operation.key, operation]));
    const wanted = [...new Set(input.operations)];
    const unknown = wanted.filter((key) => !byKey.has(key));
    if (unknown.length > 0) {
      return invalid(
        'openapi.operations',
        `The description has no importable operation “${plainText(unknown[0] ?? '', 80)}”.`,
      );
    }
    const fresh = wanted.filter((key) => !have.has(key));
    if (fresh.length === 0) {
      return invalid('openapi.operations', 'This service already has a tool for each of them.');
    }
    const tools = fresh.flatMap((key) => {
      const operation = byKey.get(key);
      return operation ? [this.fromOperation(operation, sourceName)] : [];
    });
    return { parsed, tools };
  }

  /** What the tools of a service send as their credential, checked, or none. */
  private credentialOf(
    auth: Auth,
  ): { header: string; value: string; kind: 'bearer' | 'header' } | null {
    if (auth.kind === 'none') return null;
    const value = auth.kind === 'bearer' ? auth.token : auth.value;
    if (hasControl(value)) {
      return invalid('auth', 'The credential has a character that cannot be sent in a header.');
    }
    if (auth.kind === 'header') {
      if (!HEADER_NAME.test(auth.header) || !credentialHeaderAllowed(auth.header)) {
        return invalid(
          'auth',
          `The ${plainText(auth.header, 40)} header is set by Hamnivo itself.`,
        );
      }
      return { kind: 'header', header: auth.header, value };
    }
    return { kind: 'bearer', header: 'Authorization', value };
  }

  private async storeCredential(
    tx: TenantTx,
    principal: StaffPrincipal,
    credential: { value: string } | null,
    name: string,
  ): Promise<string | null> {
    if (!credential) return null;
    return this.secrets.storeIn(tx, principal.tenantId, {
      kind: SECRET_KIND,
      label: `Custom tool credential · ${name}`,
      value: credential.value,
    });
  }

  /** Stores tools for a service, in review, with the safest policy and a name that is free. */
  private async insertTools(
    tx: TenantTx,
    principal: StaffPrincipal,
    source: SourceRow,
    tools: Prepared[],
  ): Promise<string[]> {
    const taken = new Set(
      (
        await tx
          .select({ name: schema.toolDefinitions.name })
          .from(schema.toolDefinitions)
          .where(eq(schema.toolDefinitions.brandId, source.brandId))
      ).map((row) => row.name),
    );
    const host = new URL(source.baseUrl).hostname;
    const names: string[] = [];
    for (const prepared of tools) {
      const name = freeName(prepared.baseName, taken);
      taken.add(name);
      const [tool] = await tx
        .insert(schema.toolDefinitions)
        .values({
          tenantId: principal.tenantId,
          workspaceId: source.workspaceId,
          brandId: source.brandId,
          name,
          title: prepared.title,
          description: prepared.description,
          remoteDescription: prepared.remoteDescription,
          source: 'http',
          remoteDigest: prepared.digest,
          inputSchema: prepared.assembled.inputSchema as unknown as Record<string, unknown>,
          outputSchema: null,
          risk: prepared.risk,
          approver: 'staff',
          autopilot: false,
          customerStepUp: false,
          egressHosts: [host],
          status: 'review',
          createdBy: principal.staffMemberId,
          updatedBy: principal.staffMemberId,
        })
        .returning();
      if (!tool) throw new Error('tool insert returned nothing');
      await tx.insert(schema.httpToolEndpoints).values({
        tenantId: principal.tenantId,
        sourceId: source.id,
        toolId: tool.id,
        operationId: prepared.operationId,
        method: prepared.assembled.method,
        pathTemplate: prepared.assembled.pathTemplate,
        parameters: prepared.assembled.parameters,
        bodyMode: prepared.assembled.bodyMode,
        bodyFields: prepared.assembled.bodyFields,
      });
      names.push(name);
    }
    return names;
  }

  // ── Services ────────────────────────────────────────────────────────────────────────

  async create(principal: StaffPrincipal, input: Create): Promise<HttpToolSource> {
    checkServiceAddress(this.config, input.baseUrl, 'baseUrl');
    const credential = this.credentialOf(input.auth);
    let imported: { parsed: ParsedSpec; tools: Prepared[] } | null = null;
    let tools: Prepared[];
    if (input.openapi) {
      imported = await this.fromImport(principal, input.openapi, input.name, new Set());
      tools = imported.tools;
    } else {
      tools = [this.fromEndpoint(input.endpoint as Endpoint)];
    }
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, input.brandId);
      enforce(
        this.decide(principal, 'tools.manage', {
          workspaceId: brand.workspaceId,
          brandId: brand.id,
        }),
      );
      await checkWorkspaceSide(this.egress, this.config, tx, input.baseUrl, 'baseUrl');
      const authSecretId = await this.storeCredential(tx, principal, credential, input.name);
      let source: SourceRow | undefined;
      try {
        [source] = await tx
          .insert(schema.httpToolSources)
          .values({
            tenantId: principal.tenantId,
            workspaceId: brand.workspaceId,
            brandId: brand.id,
            name: input.name,
            kind: imported ? 'openapi' : 'manual',
            baseUrl: input.baseUrl,
            authKind: credential?.kind ?? 'none',
            authHeader: credential?.header ?? null,
            authSecretId,
            specTitle: imported?.parsed.title ?? null,
            specVersion: imported?.parsed.version ?? null,
            specHash: imported ? Buffer.from(imported.parsed.hash, 'hex') : null,
            createdBy: principal.staffMemberId,
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError('VERSION_CONFLICT', {
            detail: 'Another service of this brand has this name.',
          });
        }
        throw error;
      }
      if (!source) throw new Error('source insert returned nothing');
      const names = await this.insertTools(tx, principal, source, tools);
      await this.audit(tx, principal, 'http_tool_source.created', source.id, {
        brand: input.brandId,
        kind: source.kind,
        host: new URL(source.baseUrl).hostname,
        auth: source.authKind,
        tools: names,
      });
      return (await sourceViews(tx, [source]))[0] as HttpToolSource;
    });
  }

  async addEndpoints(
    principal: StaffPrincipal,
    publicId: string,
    input: AddEndpoints,
  ): Promise<HttpToolSource> {
    const before = await this.tx(principal, async (tx) => {
      const row = await this.loadSource(tx, principal, publicId);
      return { name: row.name, routes: await this.routesOf(tx, row.id) };
    });
    let tools: Prepared[];
    if (input.openapi) {
      tools = (await this.fromImport(principal, input.openapi, before.name, before.routes)).tools;
    } else {
      const one = this.fromEndpoint(input.endpoint as Endpoint);
      if (before.routes.has(one.key)) {
        return invalid('endpoint.path', 'This service already has a tool for that request.');
      }
      tools = [one];
    }
    return this.tx(principal, async (tx) => {
      const row = await this.loadSource(tx, principal, publicId);
      if (row.status !== 'active') {
        throw new AppError('VERSION_CONFLICT', { detail: 'Turn the service on first.' });
      }
      const routes = await this.routesOf(tx, row.id);
      const fresh = tools.filter((tool) => !routes.has(tool.key));
      if (fresh.length === 0) {
        return invalid('openapi.operations', 'This service already has a tool for each of them.');
      }
      const names = await this.insertTools(tx, principal, row, fresh);
      await this.audit(tx, principal, 'http_tool_source.endpoints_added', row.id, {
        tools: names,
      });
      return (await sourceViews(tx, [row]))[0] as HttpToolSource;
    });
  }

  async update(
    principal: StaffPrincipal,
    publicId: string,
    input: UpdateSource,
  ): Promise<HttpToolSource> {
    if (input.baseUrl !== undefined) checkServiceAddress(this.config, input.baseUrl, 'baseUrl');
    const credential = input.auth ? this.credentialOf(input.auth) : null;
    const effects = new Effects();
    const view = await this.tx(principal, async (tx) => {
      const row = await this.loadSource(tx, principal, publicId);
      const now = this.clock();
      const moved = input.baseUrl !== undefined && input.baseUrl !== row.baseUrl;
      if (moved) {
        await checkWorkspaceSide(this.egress, this.config, tx, input.baseUrl as string, 'baseUrl');
      }
      const baseUrl = moved ? (input.baseUrl as string) : row.baseUrl;

      // The credential: replaced, removed, or (at another site) never sent on.
      let authKind = row.authKind;
      let authHeader = row.authHeader;
      let authSecretId = row.authSecretId;
      let credentialChange: 'replaced' | 'removed' | 'dropped' | null = null;
      if (input.auth) {
        if (row.authSecretId) await this.secrets.revokeIn(tx, row.authSecretId);
        authSecretId = await this.storeCredential(
          tx,
          principal,
          credential,
          input.name ?? row.name,
        );
        authKind = credential?.kind ?? 'none';
        authHeader = credential?.header ?? null;
        credentialChange = credential ? 'replaced' : 'removed';
      } else if (moved && row.authSecretId) {
        // A credential is never sent to another site.
        if (new URL(baseUrl).origin !== new URL(row.baseUrl).origin) {
          await this.secrets.revokeIn(tx, row.authSecretId);
          authKind = 'none';
          authHeader = null;
          authSecretId = null;
          credentialChange = 'dropped';
        }
      }

      let superseded = 0;
      if (moved) {
        // What a tool was reviewed for was another address: it goes back to review.
        const tools = await this.toolsOf(tx, row.id);
        const oldHost = new URL(row.baseUrl).hostname;
        const newHost = new URL(baseUrl).hostname;
        for (const { tool } of tools) {
          const hosts =
            oldHost === newHost
              ? tool.egressHosts
              : [...new Set([...tool.egressHosts.filter((host) => host !== oldHost), newHost])];
          await tx
            .update(schema.toolDefinitions)
            .set({
              ...(tool.status === 'enabled' ? { status: 'review' as const } : {}),
              egressHosts: hosts,
              revision: tool.revision + 1,
              updatedBy: principal.staffMemberId,
              updatedAt: now,
            })
            .where(eq(schema.toolDefinitions.id, tool.id));
        }
        superseded = await supersedePending(
          tx,
          this.journal,
          effects,
          principal.tenantId,
          tools.map(({ tool }) => tool.id),
          now,
        );
      }

      let updated: SourceRow | undefined;
      try {
        [updated] = await tx
          .update(schema.httpToolSources)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            baseUrl,
            authKind,
            authHeader,
            authSecretId,
            updatedAt: now,
          })
          .where(eq(schema.httpToolSources.id, row.id))
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError('VERSION_CONFLICT', {
            detail: 'Another service of this brand has this name.',
          });
        }
        throw error;
      }
      await this.audit(tx, principal, 'http_tool_source.updated', row.id, {
        ...(input.name !== undefined ? { name: true } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(moved
          ? {
              host: { from: new URL(row.baseUrl).hostname, to: new URL(baseUrl).hostname },
              superseded,
            }
          : {}),
        ...(credentialChange ? { credential: credentialChange } : {}),
      });
      return (await sourceViews(tx, [updated ?? row]))[0] as HttpToolSource;
    });
    await effects.flush(this.journal);
    return view;
  }

  /**
   * Removes a service: its tools are turned off and leave the list, requests waiting on them are
   * cancelled and its credential is revoked. What the tools did stays on record, so a tool keeps
   * its name.
   */
  async remove(principal: StaffPrincipal, publicId: string): Promise<void> {
    const effects = new Effects();
    await this.tx(principal, async (tx) => {
      const row = await this.loadSource(tx, principal, publicId);
      const now = this.clock();
      const tools = await this.toolsOf(tx, row.id);
      for (const { tool } of tools) {
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
      const superseded = await supersedePending(
        tx,
        this.journal,
        effects,
        principal.tenantId,
        tools.map(({ tool }) => tool.id),
        now,
      );
      if (row.authSecretId) await this.secrets.revokeIn(tx, row.authSecretId);
      await tx
        .update(schema.httpToolSources)
        .set({
          status: 'deleted',
          authKind: 'none',
          authHeader: null,
          authSecretId: null,
          updatedAt: now,
        })
        .where(eq(schema.httpToolSources.id, row.id));
      await this.audit(tx, principal, 'http_tool_source.deleted', row.id, {
        host: new URL(row.baseUrl).hostname,
        tools: tools.length,
        superseded,
      });
    });
    await effects.flush(this.journal);
  }

  /**
   * Replaces a request written by hand. The tool keeps its name, goes back to review and the
   * requests that waited on it are cancelled: what was approved must be what runs.
   */
  async updateEndpoint(
    principal: StaffPrincipal,
    publicId: string,
    toolPublicId: string,
    input: UpdateEndpoint,
  ): Promise<HttpToolSource> {
    const prepared = this.fromEndpoint(input, '');
    const effects = new Effects();
    const view = await this.tx(principal, async (tx) => {
      const row = await this.loadSource(tx, principal, publicId);
      const tools = await this.toolsOf(tx, row.id);
      const found = tools.find(({ tool }) => tool.id === fromPublicId('tool', toolPublicId));
      if (!found) throw new AppError('NOT_FOUND', { detail: 'Tool not found.' });
      const { tool, endpoint } = found;
      if (endpoint.operationId !== null) {
        return invalid(
          'title',
          'This tool comes from an imported description. Import it again to change it.',
        );
      }
      if (input.expectedRevision !== tool.revision) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Someone changed this tool first. Reload it and apply your changes again.',
        });
      }
      const routes = await this.routesOf(tx, row.id);
      routes.delete(`${endpoint.method} ${endpoint.pathTemplate}`);
      if (routes.has(prepared.key)) {
        return invalid('path', 'This service already has a tool for that request.');
      }
      const now = this.clock();
      // A kind of tool that moves money or cannot be undone is approved by a team member, always.
      const risk = input.risk ?? tool.risk;
      const high = risk === 'money' || risk === 'irreversible';
      await tx
        .update(schema.toolDefinitions)
        .set({
          title: prepared.title,
          description: prepared.description,
          inputSchema: prepared.assembled.inputSchema as unknown as Record<string, unknown>,
          risk,
          ...(high ? { approver: 'staff' as const, autopilot: false, customerStepUp: false } : {}),
          ...(tool.status === 'enabled' ? { status: 'review' as const } : {}),
          revision: tool.revision + 1,
          updatedBy: principal.staffMemberId,
          updatedAt: now,
        })
        .where(eq(schema.toolDefinitions.id, tool.id));
      await tx
        .update(schema.httpToolEndpoints)
        .set({
          method: prepared.assembled.method,
          pathTemplate: prepared.assembled.pathTemplate,
          parameters: prepared.assembled.parameters,
          bodyMode: prepared.assembled.bodyMode,
          bodyFields: prepared.assembled.bodyFields,
          updatedAt: now,
        })
        .where(eq(schema.httpToolEndpoints.id, endpoint.id));
      const superseded = await supersedePending(
        tx,
        this.journal,
        effects,
        principal.tenantId,
        [tool.id],
        now,
      );
      await this.audit(tx, principal, 'http_tool_source.endpoint_updated', row.id, {
        tool: tool.name,
        route: prepared.key,
        risk,
        superseded,
      });
      return (await sourceViews(tx, [row]))[0] as HttpToolSource;
    });
    await effects.flush(this.journal);
    return view;
  }
}
