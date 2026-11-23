import { callShopify, callWooCommerce, StoreApiError } from '@hamnivo/adapters/stores';
import { callWhmcs } from '@hamnivo/adapters/whmcs';
import type {
  ConnectorCapability,
  ConnectorConnection,
  ConnectorKind,
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
import {
  STORE_CAPABILITIES,
  STORE_KINDS,
  STORE_SPEC,
  type StoreCapability,
  WHMCS_CAPABILITIES,
  WHMCS_SPEC,
  type WhmcsCapability,
  whmcsPermissions,
} from '@hamnivo/domain/connectors';
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

const PRODUCT: Record<ConnectorKind, string> = {
  whmcs: 'WHMCS',
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
};

/** What each kind of connection may be granted. */
export function capabilitiesOf(kind: ConnectorKind): readonly ConnectorCapability[] {
  return kind === 'whmcs' ? WHMCS_CAPABILITIES : STORE_CAPABILITIES;
}

function specOf(kind: ConnectorKind, capability: ConnectorCapability) {
  return kind === 'whmcs'
    ? WHMCS_SPEC[capability as WhmcsCapability]
    : STORE_SPEC[capability as StoreCapability];
}

function cleanOrigin(value: string, kind: ConnectorKind): string {
  const product = PRODUCT[kind];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('VALIDATION_FAILED', { detail: `A ${product} HTTPS root URL is required.` });
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `Use the public HTTPS root URL of ${product}.`,
    });
  }
  // The Admin API answers on the shop's own myshopify.com address, not its custom domain.
  if (kind === 'shopify' && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(url.hostname)) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Use the shop’s myshopify.com address, such as https://noor-books.myshopify.com/.',
    });
  }
  return `${url.origin}/`;
}

/** What a failed store check says, in plain words (never the store's own answer). */
export function storeProblem(kind: 'shopify' | 'woocommerce', error: unknown): string {
  const product = PRODUCT[kind];
  const problem = error instanceof StoreApiError ? error.kind : 'network';
  switch (problem) {
    case 'auth':
      return kind === 'shopify'
        ? 'Shopify refused the access token. Check it, and that the app may read orders (read_orders).'
        : 'WooCommerce refused the key. Check the consumer key and secret, and that the key may read.';
    case 'not_found':
      return kind === 'shopify'
        ? 'No Shopify shop answers at this address.'
        : 'WooCommerce does not answer at this address. Check that it is installed and that permalinks are not set to Plain.';
    case 'rate_limited':
      return `${product} asked Hamnivo to slow down. Try again in a minute.`;
    case 'egress':
      return `Hamnivo may not reach this address (it is private or not allowed).`;
    case 'timeout':
    case 'network':
      return `${product} did not answer. Check the address and try again.`;
    default:
      return `${product}’s answer could not be read.`;
  }
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
    const [key] = row.identityKeyId
      ? await tx
          .select({ kid: schema.brandIdentityKeys.kid })
          .from(schema.brandIdentityKeys)
          .where(eq(schema.brandIdentityKeys.id, row.identityKeyId))
      : [];
    return {
      id: toPublicId('connection', row.id),
      brandId: toPublicId('brand', row.brandId),
      kind: row.kind,
      label: row.label,
      baseUrl: row.baseUrl,
      status: row.status,
      capabilities: grants.map((g) => g.capability as ConnectorCapability),
      grantVersion: row.grantVersion,
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      lastError: row.lastError,
      identityKeyId: key?.kid ?? null,
    };
  }

  catalog() {
    return {
      items: [
        ...WHMCS_CAPABILITIES.map((key) => ({
          kind: 'whmcs' as const,
          key,
          title: WHMCS_SPEC[key].title,
          description: WHMCS_SPEC[key].description,
          risk: WHMCS_SPEC[key].risk,
          approver: WHMCS_SPEC[key].approver,
        })),
        ...STORE_KINDS.flatMap((kind) =>
          STORE_CAPABILITIES.map((key) => ({
            kind,
            key,
            title: STORE_SPEC[key].title,
            description: STORE_SPEC[key].description,
            risk: STORE_SPEC[key].risk,
            approver: STORE_SPEC[key].approver,
          })),
        ),
      ],
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
    const kind = input.kind;
    const baseUrl = cleanOrigin(input.baseUrl, kind);
    const capabilities = [...new Set(input.capabilities)];
    const allowed = capabilitiesOf(kind);
    if (capabilities.some((capability) => !allowed.includes(capability))) {
      throw new AppError('VALIDATION_FAILED', {
        detail: `Choose ${PRODUCT[kind]} capabilities only.`,
      });
    }
    const identifier = kind === 'shopify' ? null : (input.identifier ?? null);
    if (kind !== 'shopify' && !identifier) {
      throw new AppError('VALIDATION_FAILED', {
        detail:
          kind === 'whmcs'
            ? 'The WHMCS API identifier is required.'
            : 'The WooCommerce consumer key is required.',
      });
    }
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
      // WHMCS trusts one identity key's sign-ins; a store finds customers by verified email.
      let identityKeyId: string | null = null;
      if (kind === 'whmcs') {
        const [key] = input.identityKeyId
          ? await tx
              .select()
              .from(schema.brandIdentityKeys)
              .where(
                and(
                  eq(schema.brandIdentityKeys.kid, input.identityKeyId),
                  eq(schema.brandIdentityKeys.brandId, brandId),
                  eq(schema.brandIdentityKeys.status, 'active'),
                ),
              )
          : [];
        if (!key)
          throw new AppError('VALIDATION_FAILED', {
            detail:
              'This brand has no active customer sign-in key with that name. Pick one from the list, or create one under Customer sign-in.',
          });
        identityKeyId = key.id;
      }
      const identifierSecretId = identifier
        ? await this.secrets.storeIn(tx, principal.tenantId, {
            kind: `${kind}_identifier`,
            label: input.label,
            value: identifier,
          })
        : null;
      const tokenSecretId = await this.secrets.storeIn(tx, principal.tenantId, {
        kind: `${kind}_secret`,
        label: input.label,
        value: input.secret,
      });
      const [connection] = await tx
        .insert(schema.connectorConnections)
        .values({
          tenantId: principal.tenantId,
          workspaceId: brand.workspaceId,
          brandId,
          kind,
          label: input.label,
          baseUrl,
          identifierSecretId,
          tokenSecretId,
          identityKeyId,
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
    const spec = specOf(row.kind, capability);
    const id = newId();
    const name = `${row.kind}_${capability.replace('.', '_')}_${row.id.replace(/-/g, '')}`;
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
      resourceType: row.kind === 'whmcs' ? 'whmcs' : 'store',
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
      const identifier = row.identifierSecretId
        ? await this.secrets.reveal(tx, principal.tenantId, row.identifierSecretId)
        : '';
      const secret = await this.secrets.reveal(tx, principal.tenantId, row.tokenSecretId);
      const policy = await this.egress.policyIn(tx, []);
      return { row, identifier, secret, policy };
    });
    const kind = loaded.row.kind;
    let ok = false;
    let failure = 'WHMCS API test failed or the destination is blocked.';
    try {
      // One cheap read: the credential works and the address is the product's.
      if (kind === 'shopify') {
        await callShopify({
          baseUrl: loaded.row.baseUrl,
          token: loaded.secret,
          query: 'shop',
          policy: loaded.policy,
          timeoutMs: 8000,
        });
      } else if (kind === 'woocommerce') {
        await callWooCommerce({
          baseUrl: loaded.row.baseUrl,
          key: loaded.identifier,
          secret: loaded.secret,
          read: { kind: 'check' },
          policy: loaded.policy,
          timeoutMs: 8000,
        });
      } else {
        await callWhmcs({
          baseUrl: loaded.row.baseUrl,
          credentials: { identifier: loaded.identifier, secret: loaded.secret },
          action: 'GetCurrencies',
          policy: loaded.policy,
          timeoutMs: 8000,
        });
      }
      ok = true;
    } catch (error) {
      /* Recorded as a health failure in plain words; never credentials or the API's own text. */
      if (kind !== 'whmcs') failure = storeProblem(kind, error);
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
          lastError: ok ? null : failure,
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
      message: ok ? `${PRODUCT[kind]} connection is healthy.` : failure,
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
      if (row.kind !== 'whmcs' || !row.identifierSecretId) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Only WHMCS connections check a user’s permissions.',
        });
      }
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
      if (row.identifierSecretId) {
        if (!input.identifier) {
          throw new AppError('VALIDATION_FAILED', {
            detail:
              row.kind === 'whmcs'
                ? 'The WHMCS API identifier is required.'
                : 'The WooCommerce consumer key is required.',
          });
        }
        await this.secrets.rotateIn(
          tx,
          principal.tenantId,
          row.identifierSecretId,
          input.identifier,
        );
      }
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
      const allowed = capabilitiesOf(row.kind);
      if (input.capabilities.some((capability) => !allowed.includes(capability))) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `Choose ${PRODUCT[row.kind]} capabilities only.`,
        });
      }
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
