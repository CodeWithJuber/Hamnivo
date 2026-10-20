import { callWhmcs } from '@hamnivo/adapters/whmcs';
import type {
  ConnectorCapability,
  ConnectorConnection,
  ConnectorPermissionsTestResult,
  CreateConnectorRequest,
  ReconnectConnectorRequest,
  TestConnectorPermissionsRequest,
  UpdateConnectorGrantsRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { WHMCS_CAPABILITIES, WHMCS_SPEC, whmcsPermissions } from '@hamnivo/domain/connectors';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { EgressService } from '../developer/egress.service.js';
import { enforce } from '../identity/staff.guard.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type ConnectionRow = typeof schema.connectorConnections.$inferSelect;

function cleanOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('VALIDATION_FAILED', { detail: 'A WHMCS HTTPS root URL is required.' });
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new AppError('VALIDATION_FAILED', { detail: 'Use the public HTTPS root URL of WHMCS.' });
  }
  return `${url.origin}/`;
}

@Injectable()
export class ConnectorsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private async row(tx: TenantTx, id: string, principal: StaffPrincipal): Promise<ConnectionRow> {
    const [row] = await tx
      .select()
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, fromPublicId('connection', id)))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    enforce(
      authorize(
        principal,
        'tools.manage',
        { workspaceId: row.workspaceId, brandId: row.brandId },
        { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60000 },
      ),
    );
    return row;
  }

  private async view(tx: TenantTx, row: ConnectionRow): Promise<ConnectorConnection> {
    const grants = await tx
      .select({ capability: schema.connectorToolGrants.capability })
      .from(schema.connectorToolGrants)
      .where(
        and(
          eq(schema.connectorToolGrants.connectionId, row.id),
          eq(schema.connectorToolGrants.enabled, 'yes'),
        ),
      );
    const [key] = await tx
      .select({ kid: schema.brandIdentityKeys.kid })
      .from(schema.brandIdentityKeys)
      .where(eq(schema.brandIdentityKeys.id, row.identityKeyId));
    return {
      id: toPublicId('connection', row.id),
      brandId: toPublicId('brand', row.brandId),
      kind: 'whmcs',
      label: row.label,
      baseUrl: row.baseUrl,
      status: row.status,
      capabilities: grants.map((g) => g.capability as ConnectorCapability),
      grantVersion: row.grantVersion,
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      lastError: row.lastError,
      identityKeyId: key?.kid ?? '',
    };
  }

  catalog() {
    return {
      items: WHMCS_CAPABILITIES.map((key) => ({
        key,
        title: WHMCS_SPEC[key].title,
        description: WHMCS_SPEC[key].description,
        risk: WHMCS_SPEC[key].risk,
        approver: WHMCS_SPEC[key].approver,
      })),
    };
  }

  async list(principal: StaffPrincipal, brandId?: string) {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.connectorConnections)
        .where(
          brandId
            ? eq(schema.connectorConnections.brandId, fromPublicId('brand', brandId))
            : undefined,
        );
      const visible = rows.filter(
        (row) =>
          authorize(
            principal,
            'tools.read',
            { workspaceId: row.workspaceId, brandId: row.brandId },
            { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60000 },
          ).allowed,
      );
      return { items: await Promise.all(visible.map((row) => this.view(tx, row))) };
    });
  }

  async create(
    principal: StaffPrincipal,
    input: CreateConnectorRequest,
  ): Promise<ConnectorConnection> {
    const baseUrl = cleanOrigin(input.baseUrl);
    const capabilities = [...new Set(input.capabilities)];
    const result = await this.tx(principal, async (tx) => {
      const brandId = fromPublicId('brand', input.brandId);
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND');
      enforce(
        authorize(
          principal,
          'tools.manage',
          { workspaceId: brand.workspaceId, brandId },
          { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60000 },
        ),
      );
      const [key] = await tx
        .select()
        .from(schema.brandIdentityKeys)
        .where(
          and(
            eq(schema.brandIdentityKeys.kid, input.identityKeyId),
            eq(schema.brandIdentityKeys.brandId, brandId),
            eq(schema.brandIdentityKeys.status, 'active'),
          ),
        );
      if (!key)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Choose an active identity key of this brand.',
        });
      const identifierSecretId = await this.secrets.storeIn(tx, principal.tenantId, {
        kind: 'whmcs_identifier',
        label: input.label,
        value: input.identifier,
      });
      const tokenSecretId = await this.secrets.storeIn(tx, principal.tenantId, {
        kind: 'whmcs_secret',
        label: input.label,
        value: input.secret,
      });
      const [connection] = await tx
        .insert(schema.connectorConnections)
        .values({
          tenantId: principal.tenantId,
          workspaceId: brand.workspaceId,
          brandId,
          kind: 'whmcs',
          label: input.label,
          baseUrl,
          identifierSecretId,
          tokenSecretId,
          identityKeyId: key.id,
          createdBy: principal.staffMemberId,
        })
        .returning();
      if (!connection) throw new Error('connection insert failed');
      for (const capability of capabilities)
        await this.addTool(tx, connection, capability, principal.staffMemberId);
      await this.audit(tx, principal, 'connector.created', connection.id, { capabilities });
      return this.view(tx, connection);
    });
    // A failed test keeps the connection visible but disabled, with a safe health message.
    await this.test(principal, result.id);
    return this.tx(principal, async (tx) =>
      this.view(tx, await this.row(tx, result.id, principal)),
    );
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    id: string,
    data: Record<string, unknown> = {},
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'connector',
      targetId: toPublicId('connection', id),
      outcome: 'success',
      data,
    });
  }

  private async addTool(
    tx: TenantTx,
    row: ConnectionRow,
    capability: ConnectorCapability,
    staffId: string,
  ): Promise<void> {
    const spec = WHMCS_SPEC[capability];
    const id = newId();
    const name = `whmcs_${capability.replace('.', '_')}_${row.id.replace(/-/g, '')}`;
    await tx.insert(schema.toolDefinitions).values({
      id,
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      brandId: row.brandId,
      name,
      title: spec.title,
      description: spec.description,
      source: 'native',
      remoteName: capability,
      inputSchema: spec.inputSchema,
      risk: spec.risk,
      approver: spec.approver,
      autopilot: spec.risk === 'read',
      customerStepUp: spec.approver === 'customer' && spec.risk !== 'read',
      resourceType: 'whmcs',
      egressHosts: [new URL(row.baseUrl).hostname],
      status: row.status === 'active' ? 'enabled' : 'disabled',
      createdBy: staffId,
      reviewedBy: staffId,
      reviewedAt: this.clock(),
    });
    await tx.insert(schema.connectorToolGrants).values({
      tenantId: row.tenantId,
      connectionId: row.id,
      toolId: id,
      capability,
      version: row.grantVersion,
    });
  }

  async test(principal: StaffPrincipal, id: string) {
    const loaded = await this.tx(principal, async (tx) => {
      const row = await this.row(tx, id, principal);
      const identifier = await this.secrets.reveal(tx, principal.tenantId, row.identifierSecretId);
      const secret = await this.secrets.reveal(tx, principal.tenantId, row.tokenSecretId);
      const policy = await this.egress.policyIn(tx, []);
      return { row, identifier, secret, policy };
    });
    let ok = false;
    try {
      await callWhmcs({
        baseUrl: loaded.row.baseUrl,
        credentials: { identifier: loaded.identifier, secret: loaded.secret },
        action: 'GetCurrencies',
        policy: loaded.policy,
        timeoutMs: 8000,
      });
      ok = true;
    } catch {
      /* The result is recorded as a generic health failure; never return credentials or API text. */
    }
    const checkedAt = this.clock();
    await this.tx(principal, async (tx) => {
      const current = await this.row(tx, id, principal);
      if (current.grantVersion !== loaded.row.grantVersion) throw new AppError('VERSION_CONFLICT');
      await tx
        .update(schema.connectorConnections)
        .set({
          status: ok ? 'active' : 'disabled',
          lastTestedAt: checkedAt,
          lastError: ok ? null : 'WHMCS API test failed or the destination is blocked.',
          grantVersion: sql`${schema.connectorConnections.grantVersion} + 1`,
        })
        .where(eq(schema.connectorConnections.id, loaded.row.id));
      await tx
        .update(schema.connectorToolGrants)
        .set({ version: loaded.row.grantVersion + 1 })
        .where(eq(schema.connectorToolGrants.connectionId, loaded.row.id));
      await tx
        .update(schema.toolDefinitions)
        .set({
          status: ok ? 'enabled' : 'disabled',
          revision: sql`${schema.toolDefinitions.revision} + 1`,
        })
        .where(
          inArray(
            schema.toolDefinitions.id,
            tx
              .select({ id: schema.connectorToolGrants.toolId })
              .from(schema.connectorToolGrants)
              .where(
                and(
                  eq(schema.connectorToolGrants.connectionId, loaded.row.id),
                  eq(schema.connectorToolGrants.enabled, 'yes'),
                ),
              ),
          ),
        );
    });
    return {
      ok,
      checkedAt: checkedAt.toISOString(),
      message: ok
        ? 'WHMCS connection is healthy.'
        : 'WHMCS API test failed or the destination is blocked.',
    };
  }

  async disable(principal: StaffPrincipal, id: string) {
    return this.tx(principal, async (tx) => {
      const row = await this.row(tx, id, principal);
      await tx
        .update(schema.connectorConnections)
        .set({ status: 'disabled', grantVersion: row.grantVersion + 1 })
        .where(eq(schema.connectorConnections.id, row.id));
      await tx
        .update(schema.connectorToolGrants)
        .set({ version: row.grantVersion + 1 })
        .where(eq(schema.connectorToolGrants.connectionId, row.id));
      await tx
        .update(schema.toolDefinitions)
        .set({ status: 'disabled', revision: sql`${schema.toolDefinitions.revision} + 1` })
        .where(
          inArray(
            schema.toolDefinitions.id,
            tx
              .select({ id: schema.connectorToolGrants.toolId })
              .from(schema.connectorToolGrants)
              .where(eq(schema.connectorToolGrants.connectionId, row.id)),
          ),
        );
      await this.audit(tx, principal, 'connector.disabled', row.id);
      return this.view(tx, await this.row(tx, id, principal));
    });
  }

  async testPermissions(
    principal: StaffPrincipal,
    id: string,
    input: TestConnectorPermissionsRequest,
  ): Promise<ConnectorPermissionsTestResult> {
    const loaded = await this.tx(principal, async (tx) => {
      const row = await this.row(tx, id, principal);
      return {
        row,
        credentials: {
          identifier: await this.secrets.reveal(tx, principal.tenantId, row.identifierSecretId),
          secret: await this.secrets.reveal(tx, principal.tenantId, row.tokenSecretId),
        },
        policy: await this.egress.policyIn(tx, []),
      };
    });
    let permissions: readonly string[] | null = null;
    try {
      const response = await callWhmcs({
        baseUrl: loaded.row.baseUrl,
        credentials: loaded.credentials,
        policy: loaded.policy,
        action: 'GetUserPermissions',
        fields: { user_id: input.userId, client_id: input.clientId },
        timeoutMs: 8000,
      });
      permissions = whmcsPermissions(response);
    } catch {
      /* A missing association, API failure or unknown response grants nothing. */
    }
    const checkedAt = this.clock();
    return this.tx(principal, async (tx) => {
      // Report the current reviewed grants, including changes made while the API was answering.
      const current = await this.row(tx, id, principal);
      const grants = await tx
        .select()
        .from(schema.connectorToolGrants)
        .where(eq(schema.connectorToolGrants.connectionId, current.id));
      const verified = permissions !== null && current.grantVersion === loaded.row.grantVersion;
      const items = WHMCS_CAPABILITIES.map((capability) => {
        const configured = grants.some(
          (grant) =>
            grant.capability === capability &&
            grant.enabled === 'yes' &&
            grant.version === current.grantVersion,
        );
        const requiredPermission = WHMCS_SPEC[capability].permission;
        const reason: ConnectorPermissionsTestResult['items'][number]['reason'] = !configured
          ? 'grant_disabled'
          : current.status !== 'active'
            ? 'connection_disabled'
            : !verified
              ? 'permission_unverified'
              : permissions?.includes(requiredPermission)
                ? 'allowed'
                : 'permission_denied';
        return {
          capability,
          configured,
          requiredPermission,
          allowed: reason === 'allowed',
          reason,
        };
      });
      await this.audit(tx, principal, 'connector.permissions_tested', current.id, {
        userId: input.userId,
        clientId: input.clientId,
        verified,
        allowed: items.filter((item) => item.allowed).map((item) => item.capability),
      });
      return {
        ok: verified,
        checkedAt: checkedAt.toISOString(),
        userId: input.userId,
        clientId: input.clientId,
        items,
      };
    });
  }

  async reconnect(principal: StaffPrincipal, id: string, input: ReconnectConnectorRequest) {
    await this.tx(principal, async (tx) => {
      const row = await this.row(tx, id, principal);
      await this.secrets.rotateIn(tx, principal.tenantId, row.identifierSecretId, input.identifier);
      await this.secrets.rotateIn(tx, principal.tenantId, row.tokenSecretId, input.secret);
      // A request inspected with the old credential must fail its final version check.
      await tx
        .update(schema.connectorConnections)
        .set({ status: 'disabled', grantVersion: row.grantVersion + 1 })
        .where(eq(schema.connectorConnections.id, row.id));
      await tx
        .update(schema.connectorToolGrants)
        .set({ version: row.grantVersion + 1 })
        .where(eq(schema.connectorToolGrants.connectionId, row.id));
      await tx
        .update(schema.toolDefinitions)
        .set({ status: 'disabled', revision: sql`${schema.toolDefinitions.revision} + 1` })
        .where(
          inArray(
            schema.toolDefinitions.id,
            tx
              .select({ id: schema.connectorToolGrants.toolId })
              .from(schema.connectorToolGrants)
              .where(eq(schema.connectorToolGrants.connectionId, row.id)),
          ),
        );
      await this.audit(tx, principal, 'connector.credential_rotated', row.id);
    });
    await this.test(principal, id);
    return this.tx(principal, async (tx) => this.view(tx, await this.row(tx, id, principal)));
  }

  async grants(principal: StaffPrincipal, id: string, input: UpdateConnectorGrantsRequest) {
    return this.tx(principal, async (tx) => {
      const row = await this.row(tx, id, principal);
      if (row.grantVersion !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      const current = await tx
        .select()
        .from(schema.connectorToolGrants)
        .where(eq(schema.connectorToolGrants.connectionId, row.id));
      const wanted = new Set(input.capabilities);
      for (const grant of current) {
        const enabled = wanted.has(grant.capability as ConnectorCapability) ? 'yes' : 'no';
        await tx
          .update(schema.connectorToolGrants)
          .set({ enabled, version: row.grantVersion + 1 })
          .where(eq(schema.connectorToolGrants.id, grant.id));
        await tx
          .update(schema.toolDefinitions)
          .set({
            status: enabled === 'yes' && row.status === 'active' ? 'enabled' : 'disabled',
            revision: sql`${schema.toolDefinitions.revision} + 1`,
          })
          .where(eq(schema.toolDefinitions.id, grant.toolId));
      }
      const existing = new Set(current.map((g) => g.capability));
      for (const capability of wanted)
        if (!existing.has(capability))
          await this.addTool(
            tx,
            { ...row, grantVersion: row.grantVersion + 1 },
            capability,
            principal.staffMemberId,
          );
      await tx
        .update(schema.connectorConnections)
        .set({ grantVersion: row.grantVersion + 1 })
        .where(eq(schema.connectorConnections.id, row.id));
      await this.audit(tx, principal, 'connector.grants_updated', row.id, {
        capabilities: [...wanted],
        version: row.grantVersion + 1,
      });
      return this.view(tx, await this.row(tx, id, principal));
    });
  }
}
