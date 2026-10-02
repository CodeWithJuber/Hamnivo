import {
  ContactPart,
  LocationPart,
  type MessagePart,
  ReactionEmoji,
  ReactionPart,
} from '@hamnivo/contracts';
import { fromPublicId, toPublicId } from '@hamnivo/db';
import type { AuthorityAttachment, AuthorityMessage } from '@hamnivo/domain';
import { uuidV5 } from './uuid.js';

/**
 * Message parts beyond text that come from the authority (W09, W22, W23, W24): files, shared
 * places and contacts, a customer's reaction, and the marker of a deleted message.
 */

/**
 * Stable id (upl_…) of a file in an authority message, derived from the message's own public id,
 * so every path that maps the message (API, webhook, reconciler, history) names it the same way.
 */
export function attachmentPublicId(messagePublicId: string, attachmentRef: string): string {
  return toPublicId(
    'upload',
    uuidV5(fromPublicId('message', messagePublicId), `attachment:${attachmentRef}`),
  );
}

/** A deleted message keeps its place, without its text or files (W23). */
export const DELETED_PART: MessagePart = {
  type: 'notice',
  notice: 'message_deleted',
  text: 'This message was deleted.',
};

export function isDeleted(message: Pick<AuthorityMessage, 'contentAttributes'>): boolean {
  return message.contentAttributes.deleted === true;
}

/**
 * The reaction an incoming message carries (W22), as Hamnivo wrote it: `hv.reaction` with one of
 * the offered emoji and the id of the message reacted to. Anything else is not a reaction.
 */
export function reactionOf(message: AuthorityMessage): MessagePart | null {
  if (message.direction !== 'incoming') return null;
  const hv = message.contentAttributes.hv as { reaction?: unknown } | undefined;
  const reaction = hv?.reaction as { emoji?: unknown; messageId?: unknown } | undefined;
  if (!reaction) return null;
  const parsed = ReactionPart.safeParse({
    type: 'reaction',
    emoji: reaction.emoji,
    messageId: reaction.messageId,
  });
  return parsed.success && ReactionEmoji.safeParse(parsed.data.emoji).success ? parsed.data : null;
}

const NAMES = ['firstName', 'lastName', 'first_name', 'last_name'] as const;

/** A shared contact (W24): Chatwoot keeps its phone number as the title and names in meta. */
function contactPart(attachment: AuthorityAttachment): MessagePart {
  const meta = attachment.meta ?? {};
  const name =
    NAMES.map((key) => meta[key])
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .join(' ')
      .trim() ||
    attachment.fallbackTitle?.trim() ||
    '';
  const title = attachment.fallbackTitle?.trim() ?? null;
  const email = typeof meta.email === 'string' ? meta.email.trim() : null;
  const parsed = ContactPart.safeParse({
    type: 'contact',
    name: name.slice(0, 120),
    phone: title && /^\+?[0-9][0-9 ()\-.]{2,31}$/.test(title) ? title : null,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
  });
  return parsed.success
    ? parsed.data
    : { type: 'unknown', originalType: 'contact', fallbackText: title?.slice(0, 2000) ?? null };
}

/** A shared place (W24); without valid coordinates it degrades to its title as text. */
function locationPart(attachment: AuthorityAttachment): MessagePart {
  const parsed = LocationPart.safeParse({
    type: 'location',
    latitude: attachment.coordinates?.latitude,
    longitude: attachment.coordinates?.longitude,
    label: attachment.fallbackTitle?.trim().slice(0, 300) || null,
  });
  return parsed.success
    ? parsed.data
    : {
        type: 'unknown',
        originalType: 'location',
        fallbackText: attachment.fallbackTitle?.slice(0, 2000) ?? null,
      };
}

/**
 * The parts for an authority message's attachments. Files are listed by name, type and size;
 * their bytes are only ever served through the gateway, after an authorization check.
 */
export function attachmentParts(message: AuthorityMessage, messagePublicId: string): MessagePart[] {
  return message.attachments.map((attachment): MessagePart => {
    if (attachment.fileType === 'location') return locationPart(attachment);
    if (attachment.fileType === 'contact') return contactPart(attachment);
    return {
      type: 'attachment',
      uploadId: attachmentPublicId(messagePublicId, attachment.ref),
      name: (attachment.name ?? 'file').slice(0, 255),
      mimeType: (attachment.mimeType ?? 'application/octet-stream').slice(0, 127),
      sizeBytes: Math.max(0, Math.trunc(attachment.size ?? 0)),
      status: 'available',
    };
  });
}
