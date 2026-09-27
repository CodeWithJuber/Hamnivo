import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * Typed wrappers for the SECURITY DEFINER functions in schema `app`. They are the only way the
 * application role reads across tenants: pre-tenant lookups (which tenant does this widget, API
 * key, webhook or session belong to?) and worker maintenance. Everything else uses withTenant().
 */

export interface WidgetResolution {
  tenantId: string;
  workspaceId: string;
  brandId: string;
  allowedOrigins: string[];
  brandStatus: string;
  tenantStatus: string;
  configVersion: number;
}

export async function resolveWidget(db: Db, publicId: string): Promise<WidgetResolution | null> {
  const { rows } = await db.execute<{
    tenant_id: string;
    workspace_id: string;
    brand_id: string;
    allowed_origins: string[];
    brand_status: string;
    tenant_status: string;
    config_version: number;
  }>(sql`select * from app.resolve_widget(${publicId})`);
  const row = rows[0];
  return row
    ? {
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        brandId: row.brand_id,
        allowedOrigins: row.allowed_origins,
        brandStatus: row.brand_status,
        tenantStatus: row.tenant_status,
        configVersion: row.config_version,
      }
    : null;
}

export async function resolveWidgetSession(db: Db, sessionId: string): Promise<string | null> {
  const { rows } = await db.execute<{ tenant_id: string }>(
    sql`select * from app.resolve_widget_session(${sessionId}::uuid)`,
  );
  return rows[0]?.tenant_id ?? null;
}

export interface ApiKeyResolution {
  tenantId: string;
  keyId: string;
  serviceAccountId: string;
  secretHash: Buffer;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  tenantStatus: string;
}

export async function resolveApiKey(db: Db, prefix: string): Promise<ApiKeyResolution | null> {
  const { rows } = await db.execute<{
    tenant_id: string;
    key_id: string;
    service_account_id: string;
    secret_hash: Buffer;
    scopes: string[];
    expires_at: Date | null;
    revoked_at: Date | null;
    tenant_status: string;
  }>(sql`select * from app.resolve_api_key(${prefix})`);
  const row = rows[0];
  return row
    ? {
        tenantId: row.tenant_id,
        keyId: row.key_id,
        serviceAccountId: row.service_account_id,
        secretHash: row.secret_hash,
        scopes: row.scopes,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        tenantStatus: row.tenant_status,
      }
    : null;
}

export interface AuthorityConnectionResolution {
  tenantId: string;
  kind: string;
  status: string;
  baseUrl: string;
  accountId: number;
}

export async function resolveAuthorityConnection(
  db: Db,
  connectionId: string,
): Promise<AuthorityConnectionResolution | null> {
  const { rows } = await db.execute<{
    tenant_id: string;
    kind: string;
    status: string;
    base_url: string;
    account_id: number;
  }>(sql`select * from app.resolve_authority_connection(${connectionId}::uuid)`);
  const row = rows[0];
  return row
    ? {
        tenantId: row.tenant_id,
        kind: row.kind,
        status: row.status,
        baseUrl: row.base_url,
        accountId: row.account_id,
      }
    : null;
}

export interface StaffMembership {
  tenantId: string;
  staffMemberId: string;
  staffStatus: string;
  tenantSlug: string;
  tenantName: string;
  tenantStatus: string;
}

export async function resolveStaffMemberships(
  db: Db,
  authUserId: string,
): Promise<StaffMembership[]> {
  const { rows } = await db.execute<{
    tenant_id: string;
    staff_member_id: string;
    staff_status: string;
    tenant_slug: string;
    tenant_name: string;
    tenant_status: string;
  }>(sql`select * from app.resolve_staff_memberships(${authUserId})`);
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    staffMemberId: row.staff_member_id,
    staffStatus: row.staff_status,
    tenantSlug: row.tenant_slug,
    tenantName: row.tenant_name,
    tenantStatus: row.tenant_status,
  }));
}

export async function resolveTenantSlug(
  db: Db,
  slug: string,
): Promise<{ tenantId: string; tenantStatus: string } | null> {
  const { rows } = await db.execute<{ tenant_id: string; tenant_status: string }>(
    sql`select * from app.resolve_tenant_slug(${slug})`,
  );
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, tenantStatus: row.tenant_status } : null;
}

export async function resolveInvitation(
  db: Db,
  invitationId: string,
): Promise<{ tenantId: string; status: string; expiresAt: Date } | null> {
  const { rows } = await db.execute<{ tenant_id: string; status: string; expires_at: Date }>(
    sql`select * from app.resolve_invitation(${invitationId}::uuid)`,
  );
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, status: row.status, expiresAt: row.expires_at } : null;
}

export interface ClaimedOutboxEvent {
  tenantId: string;
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  headers: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

/** Leases due outbox events across tenants; acknowledge each one inside withTenant(). */
export async function claimOutbox(
  db: Db,
  options: { limit: number; leaseSeconds: number },
): Promise<ClaimedOutboxEvent[]> {
  const { rows } = await db.execute<{
    tenant_id: string;
    id: string;
    topic: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: unknown;
    headers: Record<string, unknown>;
    attempts: number;
    created_at: Date;
  }>(sql`select * from app.claim_outbox(${options.limit}::int, ${options.leaseSeconds}::int)`);
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    id: row.id,
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    headers: row.headers,
    attempts: row.attempts,
    createdAt: row.created_at,
  }));
}

export interface ClaimedInboxEvent {
  tenantId: string;
  id: string;
  connectionId: string;
  attempts: number;
}

/**
 * Leases up to `limit` due integration-inbox events across tenants for `leaseSeconds`. Each event
 * is then processed (and marked processed) inside withTenant(); an unfinished lease simply expires.
 */
export async function claimIntegrationInbox(
  db: Db,
  options: { limit: number; leaseSeconds: number },
): Promise<ClaimedInboxEvent[]> {
  const { rows } = await db.execute<{
    tenant_id: string;
    id: string;
    connection_id: string;
    attempts: number;
  }>(
    sql`select * from app.claim_integration_inbox(${options.limit}::int, ${options.leaseSeconds}::int)`,
  );
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    id: row.id,
    connectionId: row.connection_id,
    attempts: row.attempts,
  }));
}

/**
 * Deletes expired journal entries, identity nonces and idempotency keys, and integration-inbox
 * events processed more than seven days ago (per-table batch).
 */
export async function purgeExpired(db: Db, batch = 5000): Promise<Record<string, number>> {
  const { rows } = await db.execute<{ relation: string; deleted: string }>(
    sql`select * from app.purge_expired(${batch}::int)`,
  );
  return Object.fromEntries(rows.map((row) => [row.relation, Number(row.deleted)]));
}

/** Pre-creates monthly audit partitions; the worker runs this daily. */
export async function ensureAuditPartitions(db: Db, monthsAhead = 2): Promise<number> {
  const { rows } = await db.execute<{ created: number }>(
    sql`select app.ensure_audit_partitions(${monthsAhead}::int) as created`,
  );
  return rows[0]?.created ?? 0;
}
