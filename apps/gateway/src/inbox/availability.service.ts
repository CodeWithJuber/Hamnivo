import type { AvailabilityStatus, StaffAvailability } from '@hamnivo/contracts';
import { schema, type TenantTx } from '@hamnivo/db';
import type { ResourceScope, StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { CLOCK, type Clock, REDIS } from '../tokens.js';
import { InboxAccess } from './access.js';
import { eligibleStaffAt } from './eligible.js';

/** Studio pings every 30 seconds; a person unheard of for this long is offline. */
export const SEEN_TTL_MS = 150_000;

const seenKey = (tenantId: string, staffMemberId: string) =>
  `hamnivo:staff-seen:${tenantId}:${staffMemberId}`;

/** What Studio last said about itself. */
export interface Seen {
  /** When (ms). */
  at: number;
  /** The person used Studio lately (not just left a tab open). */
  active: boolean;
}

/**
 * What others see of a person: their choice, adjusted by whether Studio is really open and used.
 * `offline` when they chose it or nobody has heard from their Studio lately; `away` when they chose
 * it, or chose online but have not touched Studio for a while.
 */
export function effectiveStatus(
  choice: AvailabilityStatus,
  seen: Seen | null,
  now: number,
): AvailabilityStatus {
  if (choice === 'offline') return 'offline';
  if (!seen || now - seen.at > SEEN_TTL_MS) return 'offline';
  if (choice === 'away') return 'away';
  return seen.active ? 'online' : 'away';
}

/**
 * Online, away and offline for staff (item 4 of the inbox). The choice is stored with the person's
 * other inbox settings; whether they are really there comes from Studio's pings, kept in Valkey
 * for a few minutes and never in the database. The chat widget uses it to say honestly that a
 * person is available.
 */
@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly access: InboxAccess,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async seenOf(tenantId: string, staffMemberIds: string[]): Promise<Map<string, Seen>> {
    const out = new Map<string, Seen>();
    if (staffMemberIds.length === 0) return out;
    try {
      const values = await this.redis.mget(staffMemberIds.map((id) => seenKey(tenantId, id)));
      values.forEach((raw, index) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as Partial<Seen>;
          const id = staffMemberIds[index];
          if (id && typeof parsed.at === 'number' && typeof parsed.active === 'boolean') {
            out.set(id, { at: parsed.at, active: parsed.active });
          }
        } catch {
          // An unreadable record counts as unheard of.
        }
      });
    } catch (error) {
      this.logger.warn(`availability read failed: ${String(error)}`);
    }
    return out;
  }

  private async choicesOf(
    tx: TenantTx,
    staffMemberIds: string[],
  ): Promise<Map<string, AvailabilityStatus>> {
    if (staffMemberIds.length === 0) return new Map();
    const rows = await tx
      .select({
        staffMemberId: schema.staffInboxPreferences.staffMemberId,
        availability: schema.staffInboxPreferences.availability,
      })
      .from(schema.staffInboxPreferences)
      .where(inArray(schema.staffInboxPreferences.staffMemberId, staffMemberIds));
    return new Map(rows.map((row) => [row.staffMemberId, row.availability]));
  }

  /** The effective status of each person (people who never chose are online while Studio is open). */
  async statuses(
    tx: TenantTx,
    tenantId: string,
    staffMemberIds: string[],
  ): Promise<Map<string, AvailabilityStatus>> {
    const [choices, seen] = await Promise.all([
      this.choicesOf(tx, staffMemberIds),
      this.seenOf(tenantId, staffMemberIds),
    ]);
    const now = this.clock().getTime();
    return new Map(
      staffMemberIds.map((id) => [
        id,
        effectiveStatus(choices.get(id) ?? 'online', seen.get(id) ?? null, now),
      ]),
    );
  }

  /** Whether anyone who can answer at `resource` is online right now. */
  async anyOnline(tx: TenantTx, tenantId: string, resource: ResourceScope): Promise<boolean> {
    try {
      const eligible = await eligibleStaffAt(tx, resource, this.clock());
      const statuses = await this.statuses(
        tx,
        tenantId,
        eligible.map((person) => person.staffMemberId),
      );
      return [...statuses.values()].includes('online');
    } catch (error) {
      // An honest "unknown" is "nobody": never claim a person is standing by on a guess.
      this.logger.warn(`availability check failed: ${String(error)}`);
      return false;
    }
  }

  async get(principal: StaffPrincipal): Promise<StaffAvailability> {
    const status = await this.access.tx(principal, (tx) =>
      this.statuses(tx, principal.tenantId, [principal.staffMemberId]),
    );
    const [row] = await this.access.tx(principal, (tx) =>
      tx
        .select({ availability: schema.staffInboxPreferences.availability })
        .from(schema.staffInboxPreferences)
        .where(eq(schema.staffInboxPreferences.staffMemberId, principal.staffMemberId)),
    );
    return {
      choice: row?.availability ?? 'online',
      effective: status.get(principal.staffMemberId) ?? 'offline',
    };
  }

  async choose(principal: StaffPrincipal, status: AvailabilityStatus): Promise<StaffAvailability> {
    await this.access.tx(principal, (tx) =>
      tx
        .insert(schema.staffInboxPreferences)
        .values({
          tenantId: principal.tenantId,
          staffMemberId: principal.staffMemberId,
          availability: status,
        })
        .onConflictDoUpdate({
          target: [
            schema.staffInboxPreferences.tenantId,
            schema.staffInboxPreferences.staffMemberId,
          ],
          set: { availability: status, updatedAt: this.clock() },
        }),
    );
    // Choosing is a sign of life too: the person is at Studio.
    await this.touch(principal, true);
    return this.get(principal);
  }

  /** Records Studio's sign of life. */
  async touch(principal: StaffPrincipal, active: boolean): Promise<void> {
    const seen: Seen = { at: this.clock().getTime(), active };
    try {
      await this.redis.set(
        seenKey(principal.tenantId, principal.staffMemberId),
        JSON.stringify(seen),
        'PX',
        SEEN_TTL_MS + 30_000,
      );
    } catch (error) {
      this.logger.warn(`availability ping failed: ${String(error)}`);
    }
  }

  async ping(principal: StaffPrincipal, active: boolean): Promise<StaffAvailability> {
    await this.touch(principal, active);
    return this.get(principal);
  }
}
