import { z } from 'zod';
import { MinorUnits, Timestamp } from './common.js';
import { typeId } from './ids.js';
import { TicketSource } from './tickets.js';

/**
 * Product analytics (O04, board 23). Aggregates only: no message content, no customer names. A
 * value computed from fewer than `minimumGroupSize` conversations or responses is `null` with
 * `suppressed: true`, and zero is shown as zero, so "none" and "a few" stay distinct.
 */

const IsoDate = z.iso.date().meta({ description: 'Calendar date (YYYY-MM-DD) in `timezone`' });

export const AnalyticsQuery = z
  .object({
    from: IsoDate,
    to: IsoDate,
    /** IANA time zone the days are counted in. */
    timezone: z.string().min(1).max(64).default('UTC'),
    teamId: typeId('team').optional(),
    brandId: typeId('brand').optional(),
    /** Channel type as the conversation authority names it, e.g. `Channel::Api`. */
    channel: z.string().max(64).optional(),
  })
  .meta({ id: 'AnalyticsQuery' });

/** A number that may be withheld because too few conversations stand behind it. */
const Held = z.number().nullable();

export const AnalyticsMetric = z.object({
  value: Held,
  suppressed: z.boolean(),
  /** How many conversations or responses the value stands on. */
  sample: z.int().nonnegative(),
});

export const AnalyticsOverview = z
  .object({
    range: z.object({ from: IsoDate, to: IsoDate, timezone: z.string(), days: z.int() }),
    previousRange: z.object({ from: IsoDate, to: IsoDate }),
    minimumGroupSize: z.int().positive(),
    /** Analytics started recording at this time; earlier conversations are not counted. */
    recordingSince: Timestamp.nullable(),
    /** Part of the range lies before recording started. */
    partial: z.boolean(),
    generatedAt: Timestamp,
    totals: z.object({
      conversations: z.object({ value: z.int().nonnegative(), previous: z.int().nonnegative() }),
      handedOff: AnalyticsMetric.extend({ rate: Held }),
      resolved: AnalyticsMetric.extend({ rate: Held }),
      aiResolved: AnalyticsMetric.extend({ rate: Held }),
      firstResponseMedianSeconds: AnalyticsMetric,
      resolutionMedianSeconds: AnalyticsMetric,
      csatAverage: AnalyticsMetric,
    }),
    /**
     * Chats that went wrong for the customer (O04): missed (they wrote and nobody, person or AI,
     * answered within an hour), contact form messages left while nobody could answer, and closed
     * chats the customer or staff opened again.
     */
    quality: z.object({
      /** `sample`: chats where the customer wrote at least an hour ago, or got an answer. */
      missed: AnalyticsMetric.extend({ rate: Held }),
      offlineMessages: AnalyticsMetric,
      /** `sample`: chats that were closed at least once. */
      reopened: AnalyticsMetric.extend({ rate: Held }),
    }),
    /** Tickets (H19) opened in the range, and those open now. */
    tickets: z.object({
      created: AnalyticsMetric,
      closed: AnalyticsMetric,
      /** Open or pending right now, whenever they were opened. */
      openNow: AnalyticsMetric,
      closeMedianSeconds: AnalyticsMetric,
      byPriority: z.array(
        z.object({
          priority: z.enum(['urgent', 'high', 'medium', 'low']).nullable(),
          count: Held,
          suppressed: z.boolean(),
        }),
      ),
      bySource: z.array(z.object({ source: TicketSource, count: Held, suppressed: z.boolean() })),
    }),
    daily: z.array(
      z.object({
        date: IsoDate,
        conversations: Held,
        previous: Held,
        suppressed: z.boolean(),
      }),
    ),
    handoffReasons: z.array(z.object({ reason: z.string(), count: Held, suppressed: z.boolean() })),
    teams: z.array(
      z.object({
        teamId: typeId('team').nullable(),
        name: z.string().nullable(),
        conversations: Held,
        firstResponseMedianSeconds: Held,
        handoffRate: Held,
        csatAverage: Held,
        csatResponses: z.int().nonnegative(),
        suppressed: z.boolean(),
      }),
    ),
    channels: z.array(
      z.object({
        channel: z.string().nullable(),
        conversations: Held,
        handoffRate: Held,
        suppressed: z.boolean(),
      }),
    ),
    commerce: z.array(
      z.object({
        currency: z.string(),
        orders: Held,
        revenueMinor: MinorUnits.nullable(),
        refunds: Held,
        refundedMinor: MinorUnits.nullable(),
        suppressed: z.boolean(),
      }),
    ),
    ai: z.object({
      replies: z.int().nonnegative(),
      tokensInput: z.int().nonnegative(),
      tokensOutput: z.int().nonnegative(),
      /** Conversations handed to people because a plan limit or budget stopped the AI. */
      limitHandoffs: Held,
    }),
    cache: z.object({
      /**
       * `measured`: from the answer cache's daily hit and miss counts (per brand, UTC days).
       * `not_measured`: no cache lookups in the range, or a team, inbox or channel view, which the
       * cache does not count separately.
       */
      status: z.enum(['not_measured', 'measured']),
      hitRate: Held,
    }),
  })
  .meta({ id: 'AnalyticsOverview' });
export type AnalyticsOverview = z.infer<typeof AnalyticsOverview>;
