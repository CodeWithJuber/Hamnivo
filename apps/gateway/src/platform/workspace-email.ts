import { type EmailSenderSettings, SetEmailSenderRequest } from '@hamnivo/contracts';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Inject, Injectable, Put } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { APP_DB } from '../tokens.js';

type Settings = z.infer<typeof EmailSenderSettings>;

/** The display name of the workspace's emails: its own setting, or the workspace's name. */
export async function senderNameOf(tx: TenantTx): Promise<string> {
  const [own] = await tx
    .select({ name: schema.workspaceEmailSettings.senderName })
    .from(schema.workspaceEmailSettings)
    .limit(1);
  if (own) return own.name;
  const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants).limit(1);
  return tenant?.name ?? 'Hamnivo';
}

/** Each workspace names the sender of its emails (invitations, receipts, payment notices). */
@Injectable()
export class WorkspaceEmailService {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  private async view(tx: TenantTx): Promise<Settings> {
    const [own] = await tx.select().from(schema.workspaceEmailSettings).limit(1);
    const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants).limit(1);
    return { senderName: own?.senderName ?? null, defaultName: tenant?.name ?? 'Hamnivo' };
  }

  get(principal: StaffPrincipal): Promise<Settings> {
    return withTenant(this.db, { tenantId: principal.tenantId }, (tx) => this.view(tx));
  }

  set(principal: StaffPrincipal, input: z.output<typeof SetEmailSenderRequest>): Promise<Settings> {
    const actorId = toPublicId('staff', principal.staffMemberId);
    return withTenant(this.db, { tenantId: principal.tenantId, actorId }, async (tx) => {
      const table = schema.workspaceEmailSettings;
      if (input.senderName === null) {
        await tx.delete(table).where(eq(table.tenantId, principal.tenantId));
      } else {
        await tx
          .insert(table)
          .values({
            tenantId: principal.tenantId,
            senderName: input.senderName,
            updatedBy: principal.staffMemberId,
          })
          .onConflictDoUpdate({
            target: table.tenantId,
            set: {
              senderName: input.senderName,
              updatedBy: principal.staffMemberId,
              updatedAt: new Date(),
            },
          });
      }
      await appendAudit(tx, {
        actorType: 'staff',
        actorId,
        action: 'settings.email_sender_updated',
        targetType: 'tenant',
        targetId: toPublicId('tenant', principal.tenantId),
        outcome: 'success',
        data: { senderName: input.senderName },
      });
      return this.view(tx);
    });
  }
}

@Controller('v1/admin/email-sender')
export class WorkspaceEmailController {
  constructor(private readonly emails: WorkspaceEmailService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'settings.manage' })
  get(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.emails.get(principal);
  }

  @Put()
  @StaffRoute({ tenant: true, permission: 'settings.manage' })
  set(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.emails.set(principal, parseInput(SetEmailSenderRequest, body));
  }
}
