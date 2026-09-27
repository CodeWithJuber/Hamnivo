import type { InboxConversation, OwnerReason } from '@hamnivo/contracts';
import { OwnerReason as OwnerReasons } from '@hamnivo/contracts';
import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { customerView } from '../authority/views.js';

const c = schema.conversationControls;
const st = schema.conversationInboxState;
const p = schema.customerPrincipals;
const b = schema.brands;
const i = schema.authorityInboxes;
const sm = schema.staffMembers;
const bot = schema.authorityBots;
const team = schema.teams;

/** Columns of one inbox row (conversation, queue state, customer, brand, owner and team). */
export const rowColumns = {
  control: c,
  labels: st.labels,
  snoozedUntil: st.snoozedUntil,
  teamId: st.teamId,
  teamName: team.name,
  customerName: p.displayName,
  customerKind: p.kind,
  customerLocale: p.locale,
  brandName: b.name,
  workspaceId: b.workspaceId,
  channelType: i.channelType,
  ownerStaffName: sm.displayName,
  ownerBotName: bot.name,
  /** Exact cursor value (JavaScript dates would drop the microseconds). */
  activityKey: sql<string>`to_char(${c.lastActivityAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

/** `select … from conversation_controls` with every join an inbox row needs. */
export function selectRows(tx: TenantTx) {
  return tx
    .select(rowColumns)
    .from(c)
    .innerJoin(i, eq(i.id, c.inboxId))
    .leftJoin(st, eq(st.conversationId, c.id))
    .leftJoin(p, eq(p.id, c.principalId))
    .leftJoin(b, eq(b.id, c.brandId))
    .leftJoin(sm, eq(sm.id, c.ownerStaffId))
    .leftJoin(bot, eq(bot.id, c.ownerBotId))
    .leftJoin(team, eq(team.id, st.teamId));
}

export type InboxRow = Awaited<ReturnType<ReturnType<typeof selectRows>['execute']>>[number];

/** Chatwoot channel classes → the channel shown to staff. */
export function channelOf(channelType: string): InboxConversation['channel'] {
  switch (channelType) {
    case 'Channel::Api':
    case 'Channel::WebWidget':
      return 'chat';
    case 'Channel::Email':
      return 'email';
    case 'Channel::Whatsapp':
      return 'whatsapp';
    case 'Channel::Sms':
    case 'Channel::TwilioSms':
      return 'sms';
    default:
      return 'other';
  }
}

/** Chatwoot channel classes for a channel filter. */
export function channelTypes(channel: InboxConversation['channel']): string[] {
  switch (channel) {
    case 'chat':
      return ['Channel::Api', 'Channel::WebWidget'];
    case 'email':
      return ['Channel::Email'];
    case 'whatsapp':
      return ['Channel::Whatsapp'];
    case 'sms':
      return ['Channel::Sms', 'Channel::TwilioSms'];
    case 'other':
      return ['Channel::Telegram', 'Channel::Line', 'Channel::FacebookPage', 'Channel::Instagram'];
  }
}

export interface LastMessage {
  preview: string;
  at: string;
  from: 'customer' | 'ai' | 'staff' | 'system';
}

/** The latest customer-visible message of each conversation, from the realtime journal. */
export async function lastMessages(
  tx: TenantTx,
  conversationIds: string[],
): Promise<Map<string, LastMessage>> {
  if (conversationIds.length === 0) return new Map();
  const j = schema.conversationJournal;
  const rows = await tx
    .selectDistinctOn([j.conversationId], {
      conversationId: j.conversationId,
      event: j.event,
    })
    .from(j)
    .where(
      and(
        inArray(j.conversationId, conversationIds),
        eq(j.lane, 'customer'),
        eq(j.eventType, 'message.created'),
      ),
    )
    .orderBy(j.conversationId, sql`${j.seq} desc`);
  const found = new Map<string, LastMessage>();
  for (const row of rows) {
    const message = (
      row.event as {
        data?: {
          message?: {
            parts?: { type: string; text?: string }[];
            sender?: { kind?: string };
            createdAt?: string;
          };
        };
      }
    ).data?.message;
    const text = message?.parts?.find((part) => part.type === 'text')?.text;
    if (!text || !message?.createdAt) continue;
    const kind = message.sender?.kind;
    found.set(row.conversationId, {
      preview: text.replace(/\s+/g, ' ').slice(0, 200),
      at: message.createdAt,
      from:
        kind === 'customer'
          ? 'customer'
          : kind === 'human_agent'
            ? 'staff'
            : kind === 'ai_agent' || kind === 'ai_specialist'
              ? 'ai'
              : 'system',
    });
  }
  return found;
}

const REASONS = new Set<string>(OwnerReasons.options);

export function toInboxConversation(
  row: InboxRow,
  last: LastMessage | undefined,
): InboxConversation {
  const control = row.control;
  const view = customerView(control.ownerMode, control.authorityStatus);
  let owner: InboxConversation['owner'] = { kind: 'none' };
  if (control.ownerMode === 'AI_ACTIVE') {
    owner = { kind: 'ai', displayName: row.ownerBotName ?? 'AI assistant' };
  } else if (control.ownerMode === 'HUMAN_ACTIVE') {
    owner =
      control.ownerStaffId && row.ownerStaffName
        ? {
            kind: 'staff',
            staffMemberId: toPublicId('staff', control.ownerStaffId),
            displayName: row.ownerStaffName,
          }
        : { kind: 'external', displayName: 'Chatwoot user' };
  }
  const waiting = control.ownerMode === 'WAITING_HUMAN' || control.ownerMode === 'PAUSED';
  return {
    id: toPublicId('conversation', control.id),
    brand: control.brandId
      ? { id: toPublicId('brand', control.brandId), name: row.brandName ?? '' }
      : null,
    inboxId: toPublicId('inbox', control.inboxId),
    channel: channelOf(row.channelType),
    status: control.authorityStatus,
    customerStatus: view.status,
    ownerMode: control.ownerMode,
    ownershipEpoch: control.ownershipEpoch,
    owner,
    ownerReason:
      control.ownerReason && REASONS.has(control.ownerReason)
        ? (control.ownerReason as OwnerReason)
        : null,
    ownerChangedAt: control.ownerChangedAt?.toISOString() ?? null,
    team: row.teamId ? { id: toPublicId('team', row.teamId), name: row.teamName ?? '' } : null,
    customer: {
      displayName: row.customerName?.trim() || 'Visitor',
      identity:
        row.customerKind === 'verified'
          ? 'verified'
          : row.customerKind === 'anonymous'
            ? 'anonymous'
            : 'unknown',
      language: row.customerLocale ?? null,
    },
    lastMessage: last ?? null,
    labels: row.labels ?? [],
    snoozedUntil:
      control.authorityStatus === 'snoozed' ? (row.snoozedUntil?.toISOString() ?? null) : null,
    waitingSince: waiting
      ? (control.ownerChangedAt ?? control.lastCustomerMessageAt ?? control.createdAt).toISOString()
      : null,
    lastActivityAt: control.lastActivityAt.toISOString(),
    createdAt: control.createdAt.toISOString(),
  };
}
