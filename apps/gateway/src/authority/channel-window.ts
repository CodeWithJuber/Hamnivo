import { schema, type TenantTx } from '@hamnivo/db';
import { type ChannelName, channelNameOf, replyWindowOpen } from '@hamnivo/domain';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';

/** The channel a conversation is on, from its inbox (web chat when unknown). */
export async function channelOfConversation(
  tx: TenantTx,
  control: { inboxId: string },
): Promise<ChannelName> {
  const [inbox] = await tx
    .select({ channelType: schema.authorityInboxes.channelType })
    .from(schema.authorityInboxes)
    .where(eq(schema.authorityInboxes.id, control.inboxId));
  return inbox ? channelNameOf(inbox.channelType) : 'chat';
}

/** Whether free text may be sent now (W24): WhatsApp allows it for 24 hours after the customer. */
export async function replyWindowIsOpen(
  tx: TenantTx,
  control: { inboxId: string; lastCustomerMessageAt: Date | null },
  now: Date,
): Promise<boolean> {
  const channel = await channelOfConversation(tx, control);
  return replyWindowOpen(channel, control.lastCustomerMessageAt, now);
}

/** Refuses a public message the channel would not deliver; nothing is sent. */
export async function assertReplyWindow(
  tx: TenantTx,
  control: { inboxId: string; lastCustomerMessageAt: Date | null },
  now: Date,
): Promise<void> {
  if (await replyWindowIsOpen(tx, control, now)) return;
  throw new AppError('CHANNEL_WINDOW_CLOSED', {
    detail:
      'WhatsApp only allows template messages more than 24 hours after the customer last wrote. Nothing was sent.',
  });
}
