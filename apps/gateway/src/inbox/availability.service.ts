import type {
  AvailabilityStatus,
  StaffAvailability,
  StaffPublicProfile,
  UpdateStaffPublicProfile,
  WidgetConfig,
} from '@hamnivo/contracts';
import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { ResourceScope, StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { shownName } from '../authority/staff-faces.js';
import type { AppConfig } from '../config.js';
import { CLOCK, type Clock, CONFIG, REDIS } from '../tokens.js';
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
/** Steps "usually replies in" rounds up to, in minutes. */
const REPLY_STEPS = [1, 5, 15, 30, 60, 120, 240, 480, 1440];

function profileView(
  row: { displayName: string; publicName: string | null; photoUrl: string | null } | undefined,
): StaffPublicProfile {
  if (!row) return { publicName: null, photoUrl: null, shownAs: 'Team' };
  return { publicName: row.publicName, photoUrl: row.photoUrl, shownAs: shownName(row) };
}

export type WidgetTeam = NonNullable<WidgetConfig['team']>;

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly access: InboxAccess,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
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

  /**
   * Who customers see is online for a brand (W17): at most three people who could answer now,
   * each as the first name and photo they chose (or the first word of their name, and none).
   * Nothing else about them. An honest "unknown" is nobody.
   */
  async onlineTeam(
    tx: TenantTx,
    tenantId: string,
    resource: ResourceScope,
  ): Promise<{ name: string; photoUrl: string | null }[]> {
    try {
      const eligible = await eligibleStaffAt(tx, resource, this.clock());
      const statuses = await this.statuses(
        tx,
        tenantId,
        eligible.map((person) => person.staffMemberId),
      );
      const online = eligible.filter((p) => statuses.get(p.staffMemberId) === 'online');
      if (online.length === 0) return [];
      const rows = await tx
        .select({
          id: schema.staffMembers.id,
          displayName: schema.staffMembers.displayName,
          publicName: schema.staffMembers.publicName,
          photoUrl: schema.staffMembers.photoUrl,
        })
        .from(schema.staffMembers)
        .where(
          inArray(
            schema.staffMembers.id,
            online.map((p) => p.staffMemberId),
          ),
        );
      return rows
        .map((row) => ({ name: shownName(row), photoUrl: row.photoUrl }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 3);
    } catch (error) {
      this.logger.warn(`team check failed: ${String(error)}`);
      return [];
    }
  }

  /** Minutes people usually take to reply in a brand's chats, cached for an hour per brand. */
  private readonly replyTimes = new Map<string, { at: number; minutes: number | null }>();

  /**
   * How soon people usually reply (W17): the median time from the customer's first message, or
   * the hand-over to people, to a person's first reply, over the brand's last 30 days, rounded up
   * to a plain step (1, 5, 15, 30 minutes, 1, 2, 4, 8 hours, a day). Null below the reports'
   * smallest group, so a handful of chats never speaks for the team.
   */
  async replyMinutes(tx: TenantTx, tenantId: string, brandId: string): Promise<number | null> {
    const key = `${tenantId}:${brandId}`;
    const now = this.clock().getTime();
    const cached = this.replyTimes.get(key);
    if (cached && now - cached.at < 3_600_000) return cached.minutes;
    const m = schema.conversationMetrics;
    const since = new Date(now - 30 * 86_400_000);
    const waited = sql`extract(epoch from ${m.firstHumanResponseAt} - coalesce(${m.handedOffAt}, ${m.firstCustomerMessageAt}))`;
    const [row] = await tx
      .select({
        sample: sql<number>`count(*)`,
        median: sql<number | null>`percentile_cont(0.5) within group (order by ${waited})`,
      })
      .from(m)
      .where(
        and(
          eq(m.brandId, brandId),
          gte(m.createdAt, since),
          isNotNull(m.firstHumanResponseAt),
          isNotNull(m.firstCustomerMessageAt),
          sql`${waited} >= 0`,
        ),
      );
    const sample = Number(row?.sample ?? 0);
    const seconds = row?.median === null || row?.median === undefined ? null : Number(row.median);
    const minutes =
      sample < this.config.ANALYTICS_MIN_GROUP_SIZE || seconds === null
        ? null
        : (REPLY_STEPS.find((step) => seconds <= step * 60) ?? 1440);
    this.replyTimes.set(key, { at: now, minutes });
    return minutes;
  }

  /** What customers see of the calling person (W17). */
  async publicProfile(principal: StaffPrincipal): Promise<StaffPublicProfile> {
    return this.access.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, principal.staffMemberId));
      return profileView(row);
    });
  }

  /** Changes what customers see of the calling person; only what is sent changes, null clears. */
  async updatePublicProfile(
    principal: StaffPrincipal,
    input: z.output<typeof UpdateStaffPublicProfile>,
  ): Promise<StaffPublicProfile> {
    return this.access.tx(principal, async (tx) => {
      const [row] = await tx
        .update(schema.staffMembers)
        .set({
          ...(input.publicName !== undefined ? { publicName: input.publicName } : {}),
          ...(input.photoUrl !== undefined ? { photoUrl: input.photoUrl } : {}),
          updatedAt: this.clock(),
        })
        .where(eq(schema.staffMembers.id, principal.staffMemberId))
        .returning();
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'staff.public_profile.updated',
        targetType: 'staff',
        targetId: toPublicId('staff', principal.staffMemberId),
        outcome: 'success',
        // What changed, not the values (a photo address can identify a person).
        data: {
          fields: Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined),
        },
      });
      return profileView(row);
    });
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
