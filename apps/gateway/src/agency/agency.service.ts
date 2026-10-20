import type {
  AgencyClient,
  AgencySettings,
  CreateAgencyClientRequest,
  UpdateAgencySettingsRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  resolveStaffMemberships,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation, pgErrorInfo } from '../common/pg-error.js';
import type { AppConfig } from '../config.js';
import type { AuthSession } from '../identity/auth.factory.js';
import { PrincipalService } from '../identity/principal.service.js';
import { enforce } from '../identity/staff.guard.js';
import { TenantsService } from '../identity/tenants.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type Settings = z.infer<typeof AgencySettings>;
type Client = z.infer<typeof AgencyClient>;
type SettingsInput = z.output<typeof UpdateAgencySettingsRequest>;
type CreateInput = z.output<typeof CreateAgencyClientRequest>;

const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  branding: { displayName: null, accentColor: null },
  clientLimit: null,
};

type ClientMetadata = {
  client_tenant_id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'closing';
  linked_at: Date | string;
};

@Injectable()
export class AgencyService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly principals: PrincipalService,
    private readonly tenants: TenantsService,
  ) {}

  private tenantId(publicId: string): string {
    try {
      return fromPublicId('tenant', publicId);
    } catch (error) {
      if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
      throw error;
    }
  }

  private async inAgency<T>(
    principal: StaffPrincipal,
    work: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    return withTenant(
      this.db,
      {
        tenantId: principal.tenantId,
        actorId: toPublicId('staff', principal.staffMemberId),
      },
      work,
    );
  }

  private async settingsRow(principal: StaffPrincipal): Promise<Settings> {
    return this.inAgency(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.agencyConfigs)
        .where(eq(schema.agencyConfigs.tenantId, principal.tenantId));
      return row
        ? { enabled: row.enabled, branding: row.branding, clientLimit: row.clientLimit }
        : DEFAULT_SETTINGS;
    });
  }

  async settings(principal: StaffPrincipal): Promise<Settings> {
    return this.settingsRow(principal);
  }

  async update(principal: StaffPrincipal, input: SettingsInput): Promise<Settings> {
    return this.inAgency(principal, async (tx) => {
      const [old] = await tx
        .select()
        .from(schema.agencyConfigs)
        .where(eq(schema.agencyConfigs.tenantId, principal.tenantId));
      const next: Settings = {
        enabled: input.enabled ?? old?.enabled ?? false,
        branding: { ...DEFAULT_SETTINGS.branding, ...old?.branding, ...input.branding },
        clientLimit:
          input.clientLimit === undefined ? (old?.clientLimit ?? null) : input.clientLimit,
      };
      try {
        await tx
          .insert(schema.agencyConfigs)
          .values({ tenantId: principal.tenantId, ...next })
          .onConflictDoUpdate({
            target: schema.agencyConfigs.tenantId,
            set: { ...next, updatedAt: this.clock() },
          });
      } catch (error) {
        if (pgErrorInfo(error).code === '23514') {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'A client tenant cannot enable agency mode.',
            fields: [{ path: 'enabled', message: 'Unlink this tenant from its agency first.' }],
          });
        }
        throw error;
      }
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'agency.settings_updated',
        targetType: 'tenant',
        targetId: toPublicId('tenant', principal.tenantId),
        outcome: 'success',
        data: { enabled: next.enabled, clientLimit: next.clientLimit, branding: next.branding },
      });
      return next;
    });
  }

  private async metadata(principal: StaffPrincipal): Promise<ClientMetadata[]> {
    return this.inAgency(principal, async (tx) => {
      const result = await tx.execute<ClientMetadata>(
        sql`select * from app.agency_client_metadata()`,
      );
      return result.rows;
    });
  }

  private async clientViews(principal: StaffPrincipal, session: AuthSession): Promise<Client[]> {
    const [metadata, memberships] = await Promise.all([
      this.metadata(principal),
      resolveStaffMemberships(this.db, session.user.id),
    ]);
    const active = new Set(
      memberships
        .filter((m) => m.staffStatus === 'active' && m.tenantStatus === 'active')
        .map((m) => m.tenantId),
    );
    return metadata.map((row) => ({
      tenant: {
        id: toPublicId('tenant', row.client_tenant_id),
        slug: row.slug,
        name: row.name,
        status: row.status,
      },
      linkedAt: new Date(row.linked_at).toISOString(),
      canAccess: active.has(row.client_tenant_id) && row.status === 'active',
    }));
  }

  async list(principal: StaffPrincipal, session: AuthSession): Promise<{ items: Client[] }> {
    return { items: await this.clientViews(principal, session) };
  }

  async detail(principal: StaffPrincipal, session: AuthSession, publicId: string): Promise<Client> {
    const id = this.tenantId(publicId);
    const found = (await this.clientViews(principal, session)).find(
      (item) => this.tenantId(item.tenant.id) === id,
    );
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }

  private async assertEnabled(principal: StaffPrincipal): Promise<void> {
    if (!(await this.settingsRow(principal)).enabled) {
      throw new AppError('FEATURE_DISABLED', { reason: 'agency_disabled' });
    }
  }

  async create(
    principal: StaffPrincipal,
    session: AuthSession,
    input: CreateInput,
    idempotencyKey: string | undefined,
  ): Promise<{ client: Client; replayed: boolean }> {
    await this.assertEnabled(principal);
    const created = await this.tenants.createForAgency(principal, session, input, idempotencyKey);
    const client = await this.detail(principal, session, created.membership.tenant.id);
    return { client, replayed: created.replayed };
  }

  async link(principal: StaffPrincipal, session: AuthSession, publicId: string): Promise<Client> {
    const childId = this.tenantId(publicId);
    if (childId === principal.tenantId)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'tenantId', message: 'An agency cannot link itself.' }],
      });
    await this.assertEnabled(principal);
    const child = await this.principals.principal(session, childId);
    if (!child) throw new AppError('NOT_FOUND');
    enforce(
      authorize(
        child,
        'grants.manage',
        {},
        {
          now: this.clock(),
          stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
        },
      ),
    );
    try {
      await this.inAgency(principal, async (tx) => {
        await tx.insert(schema.agencyClients).values({
          tenantId: principal.tenantId,
          clientTenantId: childId,
          createdBy: principal.staffMemberId,
        });
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'agency.client_linked',
          targetType: 'tenant',
          targetId: publicId,
          outcome: 'success',
          data: { existing: true },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'agency_clients_pkey'))
        return this.detail(principal, session, publicId);
      if (isUniqueViolation(error, 'agency_clients_one_parent_key')) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'This client is already linked to an agency.',
        });
      }
      if (pgErrorInfo(error).code === '23514') {
        throw new AppError('VALIDATION_FAILED', {
          fields: [
            {
              path: 'tenantId',
              message:
                'Client must be active, unlinked, and not an agency. Check the agency client limit.',
            },
          ],
        });
      }
      throw error;
    }
    return this.detail(principal, session, publicId);
  }

  async unlink(principal: StaffPrincipal, publicId: string): Promise<void> {
    const childId = this.tenantId(publicId);
    await this.inAgency(principal, async (tx) => {
      const [deleted] = await tx
        .delete(schema.agencyClients)
        .where(eq(schema.agencyClients.clientTenantId, childId))
        .returning({ clientTenantId: schema.agencyClients.clientTenantId });
      if (!deleted) throw new AppError('NOT_FOUND');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'agency.client_unlinked',
        targetType: 'tenant',
        targetId: publicId,
        outcome: 'success',
        data: {},
      });
    });
  }
}
