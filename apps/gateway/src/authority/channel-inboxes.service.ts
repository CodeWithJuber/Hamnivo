import {
  addInboxMembers,
  ChatwootError,
  type ChatwootInboxSummary,
  createEmailInbox,
  createTelegramInbox,
  createWhatsappInbox,
  type EmailInboxSettings,
  getEmailInbox,
  getWhatsappSetup,
  listInboxes,
  setInboxAgentBot,
  updateEmailInbox,
} from '@hamnivo/chatwoot';
import type {
  ChannelInbox,
  ConnectEmailRequest,
  ConnectTelegramRequest,
  ConnectWhatsappRequest,
  EmailChannelSettings,
  UpdateChannelRequest,
  UpdateEmailRequest,
  WhatsappSetup,
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
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { channelKindOf } from './adopt.js';
import { AuthorityRegistry } from './registry.js';

/** The inbox cursor that looks for new channel inboxes in a Chatwoot account. */
export const CHANNEL_DISCOVERY_REF = 'all';
export const CHANNEL_DISCOVERY_SECONDS = 300;
/** How often each channel inbox's recent conversations are listed (lost webhooks). */
export const CHANNEL_POLL_SECONDS = 60;

type InboxRow = typeof schema.authorityInboxes.$inferSelect;

function view(row: InboxRow, conversationsThisWeek: number): ChannelInbox {
  const health = row.health ?? null;
  return {
    id: toPublicId('inbox', row.id),
    brandId: row.brandId ? toPublicId('brand', row.brandId) : null,
    kind: channelKindOf(row.channelType),
    name: row.name ?? row.channelType.replace('Channel::', ''),
    address: row.displayAddress,
    status: row.pausedAt ? 'paused' : health && !health.ok ? 'needs_attention' : 'connected',
    problem: health && !health.ok ? (health.message ?? null) : null,
    aiAnswers: row.aiAnswers,
    defaultTeamId: row.defaultTeamId ? toPublicId('team', row.defaultTeamId) : null,
    conversationsThisWeek,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Chatwoot's field names for a mailbox, as Studio's form names them. */
const EMAIL_FIELDS: Record<string, string> = {
  name: 'name',
  email: 'address',
  imap_address: 'imap.address',
  imap_port: 'imap.port',
  imap_login: 'imap.login',
  imap_password: 'imap.password',
  imap_enable_ssl: 'imap.ssl',
  smtp_address: 'smtp.address',
  smtp_port: 'smtp.port',
  smtp_login: 'smtp.login',
  smtp_password: 'smtp.password',
};

/**
 * Chatwoot refused a mailbox (it signs in before it accepts one): its words, next to the field
 * they are about. A sign-in that failed is put on the password, the field people get wrong.
 */
function emailRefused(error: unknown): AppError {
  return channelRefused(error, EMAIL_FIELDS, 'mailbox');
}

/** Chatwoot's field names for WhatsApp and Telegram, as Studio's forms name them. */
const WHATSAPP_FIELDS: Record<string, string> = {
  name: 'name',
  phone_number: 'phoneNumber',
  provider_config: 'accessToken',
};
const TELEGRAM_FIELDS: Record<string, string> = { name: 'name', bot_token: 'botToken' };

function channelRefused(
  error: unknown,
  fields: Record<string, string>,
  what: 'mailbox' | 'WhatsApp number' | 'Telegram bot',
): AppError {
  if (!(error instanceof ChatwootError) || error.status !== 422) {
    return new AppError('AUTHORITY_UNAVAILABLE', {
      detail: `Chatwoot could not be reached to check this ${what}. Please try again.`,
      internal: error,
    });
  }
  const body = (typeof error.body === 'object' && error.body ? error.body : {}) as Record<
    string,
    unknown
  >;
  const message =
    typeof body.message === 'string' && body.message.trim()
      ? body.message.trim()
      : 'Chatwoot could not use these settings.';
  const attributes = Array.isArray(body.attributes) ? body.attributes.map(String) : [];
  let paths = attributes.map((name) => fields[name]).filter((p): p is string => !!p);
  if (paths.length === 0 && what === 'mailbox') {
    paths = /smtp/i.test(message)
      ? ['smtp.password']
      : /imap|sign in|login|authenticat/i.test(message)
        ? ['imap.password']
        : [];
  }
  return new AppError('VALIDATION_FAILED', {
    detail: `Chatwoot could not use this ${what}: ${message}`,
    fields: paths.map((path) => ({ path, message })),
  });
}

function emailSettings(input: ConnectEmailRequest | UpdateEmailRequest): EmailInboxSettings {
  return {
    name: input.name,
    email: input.address,
    imap: { ...input.imap },
    smtp: { ...input.smtp },
  };
}

/** What Chatwoot says about a channel's sign-in, as the card shows it. */
function healthOf(inbox: ChatwootInboxSummary, now: Date): NonNullable<InboxRow['health']> {
  return inbox.needsReauthorization
    ? {
        ok: false,
        message: 'Chatwoot can no longer sign in to this channel. Enter the password again.',
        checkedAt: now.toISOString(),
      }
    : { ok: true, checkedAt: now.toISOString() };
}

/** Records a channel inbox and starts following its conversations (the inbox cursor). */
async function recordChannel(
  tx: TenantTx,
  input: {
    tenantId: string;
    connectionId: string;
    brandId: string | null;
    inbox: ChatwootInboxSummary;
    now: Date;
    aiAnswers?: boolean;
    defaultTeamId?: string | null;
  },
): Promise<InboxRow> {
  const { tenantId, connectionId, inbox, now } = input;
  const [row] = await tx
    .insert(schema.authorityInboxes)
    .values({
      tenantId,
      connectionId,
      brandId: input.brandId,
      purpose: 'channel',
      externalInboxId: inbox.id,
      channelType: inbox.channelType,
      name: inbox.name,
      displayAddress: inbox.address,
      aiAnswers: input.aiAnswers ?? false,
      defaultTeamId: input.defaultTeamId ?? null,
      health: healthOf(inbox, now),
    })
    .returning();
  await tx
    .insert(schema.reconcileCursors)
    .values({
      tenantId,
      connectionId,
      scope: 'inbox',
      scopeRef: String(inbox.id),
      intervalSeconds: CHANNEL_POLL_SECONDS,
      nextPollAt: now,
    })
    .onConflictDoNothing();
  if (!row) throw new Error('channel inbox was not recorded');
  return row;
}

/**
 * The email, WhatsApp and Telegram inboxes of a brand's Chatwoot account (ADR 0013). Chatwoot
 * owns them and their credentials; Hamnivo records which exist, whether the AI answers there and
 * which team gets their conversations. The AI's bot is attached to an inbox only while the AI
 * answers on it, so Chatwoot leaves the other channels' conversations with people.
 */
@Injectable()
export class ChannelInboxesService {
  private readonly logger = new Logger(ChannelInboxesService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private decide(principal: StaffPrincipal, resource: object) {
    enforce(
      authorize(principal, 'integrations.manage', resource, {
        now: this.clock(),
        stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
      }),
    );
  }

  /** The brand's connection: the one its web chat inbox belongs to (one account per brand). */
  private async brandConnection(tx: TenantTx, principal: StaffPrincipal, brandPublicId: string) {
    const brandId = fromPublicId('brand', brandPublicId);
    const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    this.decide(principal, { workspaceId: brand.workspaceId, brandId });
    const [live] = await tx
      .select({ connectionId: schema.authorityInboxes.connectionId })
      .from(schema.authorityInboxes)
      .where(
        and(
          eq(schema.authorityInboxes.brandId, brandId),
          eq(schema.authorityInboxes.purpose, 'live'),
        ),
      );
    return { brand, connectionId: live?.connectionId ?? null };
  }

  async list(principal: StaffPrincipal, brandPublicId: string): Promise<ChannelInbox[]> {
    return this.tx(principal, async (tx) => {
      const { brand, connectionId } = await this.brandConnection(tx, principal, brandPublicId);
      if (!connectionId) return [];
      return this.views(tx, connectionId, brand.id);
    });
  }

  /** "Check for new channels": reads the account's inboxes now instead of at the next poll. */
  async find(principal: StaffPrincipal, brandPublicId: string): Promise<ChannelInbox[]> {
    const found = await this.tx(principal, (tx) =>
      this.brandConnection(tx, principal, brandPublicId),
    );
    if (!found.connectionId) return [];
    try {
      await this.discover(principal.tenantId, found.connectionId);
    } catch (error) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Chatwoot could not be reached to look for channels. Please try again.',
        internal: error,
      });
    }
    return this.list(principal, brandPublicId);
  }

  private async views(tx: TenantTx, connectionId: string, brandId: string) {
    const rows = await tx
      .select()
      .from(schema.authorityInboxes)
      .where(
        and(
          eq(schema.authorityInboxes.connectionId, connectionId),
          eq(schema.authorityInboxes.purpose, 'channel'),
          eq(schema.authorityInboxes.status, 'active'),
          or(eq(schema.authorityInboxes.brandId, brandId), isNull(schema.authorityInboxes.brandId)),
        ),
      )
      .orderBy(schema.authorityInboxes.createdAt);
    const counts = rows.length
      ? await tx
          .select({
            inboxId: schema.conversationControls.inboxId,
            n: sql<number>`count(*)::int`,
          })
          .from(schema.conversationControls)
          .where(
            and(
              inArray(
                schema.conversationControls.inboxId,
                rows.map((r) => r.id),
              ),
              gte(
                schema.conversationControls.createdAt,
                new Date(this.clock().getTime() - 7 * 86_400_000),
              ),
            ),
          )
          .groupBy(schema.conversationControls.inboxId)
      : [];
    const byInbox = new Map(counts.map((c) => [c.inboxId, c.n]));
    return rows.map((row) => view(row, byInbox.get(row.id) ?? 0));
  }

  async update(
    principal: StaffPrincipal,
    channelPublicId: string,
    input: UpdateChannelRequest,
  ): Promise<ChannelInbox> {
    const inboxId = fromPublicId('inbox', channelPublicId);
    const changed = await this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(
          and(
            eq(schema.authorityInboxes.id, inboxId),
            eq(schema.authorityInboxes.purpose, 'channel'),
          ),
        )
        .for('update');
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Channel not found.' });
      let brandId = row.brandId;
      if (input.brandId !== undefined) {
        const wanted = fromPublicId('brand', input.brandId);
        if (brandId && brandId !== wanted) {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'This channel already answers for a brand.',
            fields: [{ path: 'brandId', message: 'This channel already answers for a brand.' }],
          });
        }
        brandId = wanted;
      }
      if (!brandId) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Choose the brand this channel answers for first.',
          fields: [{ path: 'brandId', message: 'Choose a brand.' }],
        });
      }
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      this.decide(principal, { workspaceId: brand.workspaceId, brandId });
      // Claimed only for the brand whose Chatwoot account it is in.
      const [live] = await tx
        .select({ id: schema.authorityInboxes.id })
        .from(schema.authorityInboxes)
        .where(
          and(
            eq(schema.authorityInboxes.brandId, brandId),
            eq(schema.authorityInboxes.connectionId, row.connectionId),
            eq(schema.authorityInboxes.purpose, 'live'),
          ),
        );
      if (!live) {
        throw new AppError('VALIDATION_FAILED', {
          detail: "This channel is in another brand's Chatwoot account.",
          fields: [
            { path: 'brandId', message: "This channel is in another brand's Chatwoot account." },
          ],
        });
      }
      let teamId = row.defaultTeamId;
      if (input.defaultTeamId !== undefined) {
        teamId = input.defaultTeamId ? fromPublicId('team', input.defaultTeamId) : null;
        if (teamId) {
          const [team] = await tx
            .select({ id: schema.teams.id })
            .from(schema.teams)
            .where(eq(schema.teams.id, teamId));
          if (!team) {
            throw new AppError('VALIDATION_FAILED', {
              detail: 'That team no longer exists.',
              fields: [{ path: 'defaultTeamId', message: 'That team no longer exists.' }],
            });
          }
        }
      }
      const now = this.clock();
      const pausedAt =
        input.paused === undefined ? row.pausedAt : input.paused ? (row.pausedAt ?? now) : null;
      const aiAnswers = input.aiAnswers ?? row.aiAnswers;
      const [updated] = await tx
        .update(schema.authorityInboxes)
        .set({ brandId, defaultTeamId: teamId, pausedAt, aiAnswers, updatedAt: now })
        .where(eq(schema.authorityInboxes.id, row.id))
        .returning();
      if (!updated) throw new AppError('NOT_FOUND');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'channel.updated',
        targetType: 'authority_inbox',
        targetId: toPublicId('inbox', row.id),
        outcome: 'success',
        data: {
          brandId: toPublicId('brand', brandId),
          aiAnswers,
          defaultTeamId: teamId ? toPublicId('team', teamId) : null,
          paused: pausedAt !== null,
        },
      });
      return { before: row, after: updated };
    });
    const { before, after } = changed;
    // The AI's bot goes on the inbox only while the AI answers there and it is not paused.
    const wantsBot = after.aiAnswers && !after.pausedAt;
    const hadBot = before.aiAnswers && !before.pausedAt;
    if (wantsBot !== hadBot) await this.attachBot(principal.tenantId, after, wantsBot);
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.id, after.id));
      const [one] = await this.viewsFor(tx, row as InboxRow);
      return one as ChannelInbox;
    });
  }

  /**
   * Connects the brand's mailbox: Chatwoot creates the email inbox (signing in to check it) and
   * keeps the passwords; Hamnivo records the channel and follows it at once. Nothing is stored
   * when Chatwoot refuses, and the request is never kept for replays (it holds passwords).
   */
  async connectEmail(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: ConnectEmailRequest,
  ): Promise<ChannelInbox> {
    return this.connect(principal, brandPublicId, input, 'email', async (admin) => {
      try {
        return await createEmailInbox(admin, emailSettings(input));
      } catch (error) {
        throw emailRefused(error);
      }
    });
  }

  /**
   * Connects a WhatsApp Business number; returns what to paste into Meta's webhook set-up.
   * Chatwoot checks the access token with Meta and keeps it.
   */
  async connectWhatsapp(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: ConnectWhatsappRequest,
  ): Promise<{ channel: ChannelInbox; setup: WhatsappSetup }> {
    const channel = await this.connect(
      principal,
      brandPublicId,
      input,
      'whatsapp',
      async (admin) => {
        try {
          return await createWhatsappInbox(admin, input);
        } catch (error) {
          throw channelRefused(error, WHATSAPP_FIELDS, 'WhatsApp number');
        }
      },
    );
    return { channel, setup: await this.whatsappSetup(principal, channel.id) };
  }

  async connectTelegram(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: ConnectTelegramRequest,
  ): Promise<ChannelInbox> {
    return this.connect(principal, brandPublicId, input, 'telegram', async (admin) => {
      try {
        return await createTelegramInbox(admin, input);
      } catch (error) {
        throw channelRefused(error, TELEGRAM_FIELDS, 'Telegram bot');
      }
    });
  }

  /** The callback address and verify token Meta asks for (never the access token). */
  async whatsappSetup(principal: StaffPrincipal, channelPublicId: string): Promise<WhatsappSetup> {
    const row = await this.tx(principal, (tx) =>
      this.managedChannel(tx, principal, channelPublicId, 'Channel::Whatsapp'),
    );
    const runtime = await this.registry.get(principal.tenantId, row.connectionId);
    try {
      return await getWhatsappSetup({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
        inboxId: row.externalInboxId,
        publicUrl: this.config.CHATWOOT_PUBLIC_URL ?? runtime.baseUrl,
      });
    } catch (error) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Chatwoot could not be reached to read the WhatsApp set-up. Please try again.',
        internal: error,
      });
    }
  }

  /**
   * One way to connect any channel: Chatwoot creates the inbox (checking its credentials) and
   * keeps them; Hamnivo records the channel and follows it at once. Nothing is stored when
   * Chatwoot refuses, and the request is never kept for replays (it holds credentials).
   */
  private async connect(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: { aiAnswers: boolean; defaultTeamId: string | null },
    kind: 'email' | 'whatsapp' | 'telegram',
    create: (admin: {
      baseUrl: string;
      token: string;
      accountId: number;
    }) => Promise<ChatwootInboxSummary>,
  ): Promise<ChannelInbox> {
    const target = await this.tx(principal, async (tx) => {
      const { brand, connectionId } = await this.brandConnection(tx, principal, brandPublicId);
      if (!connectionId) {
        throw new AppError('FEATURE_DISABLED', {
          detail: 'Connect this brand to its chat engine first (Brands and install).',
        });
      }
      const teamId = input.defaultTeamId ? await this.team(tx, input.defaultTeamId) : null;
      return { brand, connectionId, teamId };
    });
    const runtime = await this.registry.get(principal.tenantId, target.connectionId);
    const made = await create({
      baseUrl: runtime.baseUrl,
      token: runtime.integrationToken,
      accountId: runtime.accountId,
    });
    const { row, staffUserIds } = await this.tx(principal, async (tx) => {
      const row = await recordChannel(tx, {
        tenantId: principal.tenantId,
        connectionId: target.connectionId,
        brandId: target.brand.id,
        inbox: made,
        now: this.clock(),
        aiAnswers: input.aiAnswers,
        defaultTeamId: target.teamId,
      });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'channel.connected',
        targetType: 'authority_inbox',
        targetId: toPublicId('inbox', row.id),
        outcome: 'success',
        data: {
          kind,
          brandId: toPublicId('brand', target.brand.id),
          address: made.address,
          aiAnswers: input.aiAnswers,
        },
      });
      return { row, staffUserIds: await this.linkedStaff(tx, target.connectionId) };
    });
    this.registry.invalidate(principal.tenantId, target.connectionId);
    await this.addStaff(principal.tenantId, target.connectionId, [made.id], staffUserIds);
    if (row.aiAnswers) await this.attachBot(principal.tenantId, row, true);
    return this.tx(principal, async (tx) => {
      const [one] = await this.viewsFor(tx, row);
      return one as ChannelInbox;
    });
  }

  /** An email channel the principal may manage, with the brand it answers for. */
  private emailChannel(tx: TenantTx, principal: StaffPrincipal, channelPublicId: string) {
    return this.managedChannel(tx, principal, channelPublicId, 'Channel::Email');
  }

  /** A channel of this kind the principal may manage, with the brand it answers for. */
  private async managedChannel(
    tx: TenantTx,
    principal: StaffPrincipal,
    channelPublicId: string,
    channelType: string,
  ) {
    const [row] = await tx
      .select()
      .from(schema.authorityInboxes)
      .where(
        and(
          eq(schema.authorityInboxes.id, fromPublicId('inbox', channelPublicId)),
          eq(schema.authorityInboxes.purpose, 'channel'),
          eq(schema.authorityInboxes.channelType, channelType),
          eq(schema.authorityInboxes.status, 'active'),
        ),
      );
    if (!row?.brandId) throw new AppError('NOT_FOUND', { detail: 'Channel not found.' });
    const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, row.brandId));
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Channel not found.' });
    this.decide(principal, { workspaceId: brand.workspaceId, brandId: brand.id });
    return row;
  }

  async emailSettings(
    principal: StaffPrincipal,
    channelPublicId: string,
  ): Promise<EmailChannelSettings> {
    const row = await this.tx(principal, (tx) => this.emailChannel(tx, principal, channelPublicId));
    const runtime = await this.registry.get(principal.tenantId, row.connectionId);
    let found: EmailInboxSettings;
    try {
      found = await getEmailInbox({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
        inboxId: row.externalInboxId,
      });
    } catch (error) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Chatwoot could not be reached to read this mailbox. Please try again.',
        internal: error,
      });
    }
    return {
      name: found.name || (row.name ?? 'Email'),
      address: found.email || (row.displayAddress ?? ''),
      imap: {
        address: found.imap.address,
        port: found.imap.port,
        ssl: found.imap.ssl,
        login: found.imap.login,
      },
      smtp: {
        address: found.smtp.address,
        port: found.smtp.port,
        security: found.smtp.security,
        login: found.smtp.login,
      },
    };
  }

  /** Changes a mailbox's settings in Chatwoot; a new password that works clears "Needs attention". */
  async updateEmailSettings(
    principal: StaffPrincipal,
    channelPublicId: string,
    input: UpdateEmailRequest,
  ): Promise<ChannelInbox> {
    const row = await this.tx(principal, (tx) => this.emailChannel(tx, principal, channelPublicId));
    const runtime = await this.registry.get(principal.tenantId, row.connectionId);
    try {
      await updateEmailInbox(
        {
          baseUrl: runtime.baseUrl,
          token: runtime.integrationToken,
          accountId: runtime.accountId,
          inboxId: row.externalInboxId,
        },
        emailSettings(input),
      );
    } catch (error) {
      throw emailRefused(error);
    }
    const newPassword = Boolean(input.imap.password || input.smtp.password);
    return this.tx(principal, async (tx) => {
      const now = this.clock();
      const [updated] = await tx
        .update(schema.authorityInboxes)
        .set({
          name: input.name,
          displayAddress: input.address,
          ...(newPassword ? { health: { ok: true, checkedAt: now.toISOString() } } : {}),
          updatedAt: now,
        })
        .where(eq(schema.authorityInboxes.id, row.id))
        .returning();
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'channel.settings_changed',
        targetType: 'authority_inbox',
        targetId: toPublicId('inbox', row.id),
        outcome: 'success',
        // Which settings changed, never their values' secrets.
        data: { address: input.address, passwordChanged: newPassword },
      });
      const [one] = await this.viewsFor(tx, updated as InboxRow);
      return one as ChannelInbox;
    });
  }

  private async team(tx: TenantTx, teamPublicId: string): Promise<string> {
    const teamId = fromPublicId('team', teamPublicId);
    const [team] = await tx
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    if (!team) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'That team no longer exists.',
        fields: [{ path: 'defaultTeamId', message: 'That team no longer exists.' }],
      });
    }
    return teamId;
  }

  private async linkedStaff(tx: TenantTx, connectionId: string): Promise<number[]> {
    const links = await tx
      .select({ userId: schema.staffAuthorityLinks.externalUserId })
      .from(schema.staffAuthorityLinks)
      .where(
        and(
          eq(schema.staffAuthorityLinks.connectionId, connectionId),
          eq(schema.staffAuthorityLinks.status, 'active'),
        ),
      );
    return links.map((link) => link.userId);
  }

  /** Staff already linked join new channel inboxes, so they can answer there in Chatwoot too. */
  private async addStaff(
    tenantId: string,
    connectionId: string,
    inboxIds: number[],
    userIds: number[],
  ): Promise<void> {
    if (userIds.length === 0) return;
    const runtime = await this.registry.get(tenantId, connectionId);
    for (const inboxId of inboxIds) {
      await addInboxMembers({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
        inboxId,
        userIds,
      }).catch((error: unknown) =>
        this.logger.warn(`staff not added to channel inbox ${inboxId}: ${String(error)}`),
      );
    }
  }

  private async viewsFor(tx: TenantTx, row: InboxRow) {
    return (await this.views(tx, row.connectionId, row.brandId ?? '')).filter(
      (v) => v.id === toPublicId('inbox', row.id),
    );
  }

  private async attachBot(tenantId: string, inbox: InboxRow, on: boolean): Promise<void> {
    const runtime = await this.registry.get(tenantId, inbox.connectionId);
    const bot = runtime.primaryBot;
    if (on && !bot) return;
    try {
      await setInboxAgentBot({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
        inboxId: inbox.externalInboxId,
        botId: on && bot ? bot.externalBotId : null,
      });
    } catch (error) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: on
          ? 'The setting is saved, but Chatwoot could not hand this channel to the AI yet. Please try again.'
          : 'The setting is saved, but Chatwoot could not take this channel from the AI yet. Please try again.',
        internal: error,
      });
    }
  }

  /**
   * Records the channel inboxes the account has. New ones answer for the account's brand (one
   * account per brand); inboxes gone from Chatwoot are disabled, their history kept. Returns how
   * many were added.
   */
  async discover(tenantId: string, connectionId: string): Promise<number> {
    const runtime = await this.registry.get(tenantId, connectionId);
    const found = (
      await listInboxes({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
      })
    ).filter((inbox) => inbox.channelType !== 'Channel::Api');
    const { added, staffUserIds } = await withTenant(
      this.db,
      { tenantId, actorId: 'authority' },
      async (tx) => {
        const known = await tx
          .select()
          .from(schema.authorityInboxes)
          .where(eq(schema.authorityInboxes.connectionId, connectionId));
        const byExternal = new Map(known.map((row) => [row.externalInboxId, row]));
        const brandId =
          known.find((row) => row.purpose === 'live' && row.status === 'active')?.brandId ?? null;
        const now = this.clock();
        const added: number[] = [];
        for (const inbox of found) {
          const row = byExternal.get(inbox.id);
          if (row) {
            if (row.purpose !== 'channel') continue;
            const health = healthOf(inbox, now);
            const healthChanged = (row.health?.ok ?? true) !== health.ok;
            if (row.name !== inbox.name || row.displayAddress !== inbox.address || healthChanged) {
              await tx
                .update(schema.authorityInboxes)
                .set({
                  name: inbox.name,
                  displayAddress: inbox.address,
                  ...(healthChanged ? { health } : {}),
                  updatedAt: now,
                })
                .where(eq(schema.authorityInboxes.id, row.id));
            }
            continue;
          }
          await recordChannel(tx, { tenantId, connectionId, brandId, inbox, now });
          added.push(inbox.id);
        }
        const present = new Set(found.map((inbox) => inbox.id));
        for (const row of known) {
          if (
            row.purpose !== 'channel' ||
            row.status !== 'active' ||
            present.has(row.externalInboxId)
          ) {
            continue;
          }
          await tx
            .update(schema.authorityInboxes)
            .set({ status: 'disabled', updatedAt: now })
            .where(eq(schema.authorityInboxes.id, row.id));
          await tx
            .delete(schema.reconcileCursors)
            .where(
              and(
                eq(schema.reconcileCursors.connectionId, connectionId),
                eq(schema.reconcileCursors.scope, 'inbox'),
                eq(schema.reconcileCursors.scopeRef, String(row.externalInboxId)),
              ),
            );
        }
        // The discovery cursor itself, for a connection made before channels existed.
        await tx
          .insert(schema.reconcileCursors)
          .values({
            tenantId,
            connectionId,
            scope: 'inbox',
            scopeRef: CHANNEL_DISCOVERY_REF,
            intervalSeconds: CHANNEL_DISCOVERY_SECONDS,
            nextPollAt: new Date(now.getTime() + CHANNEL_DISCOVERY_SECONDS * 1000),
          })
          .onConflictDoNothing();
        const links = added.length
          ? await tx
              .select({ userId: schema.staffAuthorityLinks.externalUserId })
              .from(schema.staffAuthorityLinks)
              .where(
                and(
                  eq(schema.staffAuthorityLinks.connectionId, connectionId),
                  eq(schema.staffAuthorityLinks.status, 'active'),
                ),
              )
          : [];
        return { added, staffUserIds: links.map((link) => link.userId) };
      },
    );
    if (added.length === 0) return 0;
    this.registry.invalidate(tenantId, connectionId);
    this.logger.log(`found ${added.length} channel inbox(es) on connection ${connectionId}`);
    // Staff already linked join the new inboxes, so they can answer there in Chatwoot as well.
    for (const inboxId of staffUserIds.length ? added : []) {
      await addInboxMembers({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
        inboxId,
        userIds: staffUserIds,
      }).catch((error: unknown) =>
        this.logger.warn(`staff not added to channel inbox ${inboxId}: ${String(error)}`),
      );
    }
    return added.length;
  }

  /** Channel inboxes of a connection that still answer (for the inbox poll). */
  async activeChannel(tx: TenantTx, connectionId: string, inboxRef: string) {
    const external = Number(inboxRef);
    if (!Number.isInteger(external)) return null;
    const [row] = await tx
      .select()
      .from(schema.authorityInboxes)
      .where(
        and(
          eq(schema.authorityInboxes.connectionId, connectionId),
          eq(schema.authorityInboxes.externalInboxId, external),
          eq(schema.authorityInboxes.purpose, 'channel'),
          ne(schema.authorityInboxes.status, 'disabled'),
        ),
      );
    return row ?? null;
  }
}
