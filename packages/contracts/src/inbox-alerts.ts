import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';

/**
 * Alerts, unread chats, availability and typing in the staff inbox. What a person chose is kept
 * per staff member; what happened (a customer wrote, a chat is waiting) reaches Studio as a signal
 * on the inbox stream, so each alert is decided by the server for the people who may see the chat.
 */

/** The notification sounds built into Studio. */
export const ALERT_SOUNDS = ['chime', 'pop', 'bell', 'drop', 'ping'] as const;
export const AlertSound = z.enum(ALERT_SOUNDS);
export type AlertSound = z.infer<typeof AlertSound>;
/** One of the sounds, or `none` to keep that event silent. */
export const AlertSoundChoice = z.union([AlertSound, z.literal('none')]);
export type AlertSoundChoice = z.infer<typeof AlertSoundChoice>;

const Volume = z.int().min(0).max(100);

export const InboxAlertSettings = z
  .object({
    sounds: z.object({
      /** Silences every sound; desktop alerts and the unread count are not affected. */
      muted: z.boolean(),
      /** 0 to 100. */
      volume: Volume,
      /** A chat is waiting for a person. */
      newChat: AlertSoundChoice,
      /** A customer wrote in a chat that is yours, or that nobody has taken yet. */
      customerMessage: AlertSoundChoice,
      /** A chat was assigned or transferred to you. */
      assigned: AlertSoundChoice,
    }),
    desktop: z.object({
      /** Show alerts outside the browser tab, when the browser allows it. */
      enabled: z.boolean(),
      /** Include the start of the customer's message in the alert. */
      showPreview: z.boolean(),
    }),
  })
  .meta({ id: 'InboxAlertSettings' });
export type InboxAlertSettings = z.infer<typeof InboxAlertSettings>;

export const UpdateInboxAlertSettings = z
  .object({
    sounds: InboxAlertSettings.shape.sounds.partial().optional(),
    desktop: InboxAlertSettings.shape.desktop.partial().optional(),
  })
  .meta({ id: 'UpdateInboxAlertSettings' });
export type UpdateInboxAlertSettings = z.infer<typeof UpdateInboxAlertSettings>;

export const DEFAULT_ALERT_SETTINGS: InboxAlertSettings = {
  sounds: { muted: false, volume: 60, newChat: 'chime', customerMessage: 'pop', assigned: 'bell' },
  desktop: { enabled: true, showPreview: true },
};

/** Whether a staff member takes chats now. */
export const AvailabilityStatus = z.enum(['online', 'away', 'offline']);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatus>;

export const StaffAvailability = z
  .object({
    /** What the person chose. */
    choice: AvailabilityStatus,
    /**
     * What others see. `offline` also when nobody has Studio open; `away` also when the person
     * chose online but has not touched Studio for a while.
     */
    effective: AvailabilityStatus,
  })
  .meta({ id: 'StaffAvailability' });
export type StaffAvailability = z.infer<typeof StaffAvailability>;

export const InboxPreferences = z
  .object({ alerts: InboxAlertSettings, availability: StaffAvailability })
  .meta({ id: 'InboxPreferences' });
export type InboxPreferences = z.infer<typeof InboxPreferences>;

export const SetAvailabilityRequest = z
  .object({ status: AvailabilityStatus })
  .meta({ id: 'SetAvailabilityRequest' });

/** Studio's sign of life, every 30 seconds while it is open. */
export const AvailabilityPing = z
  .object({
    /** The person used Studio in the last five minutes. */
    active: z.boolean(),
  })
  .meta({ id: 'AvailabilityPing' });

/** How many chats need this person's attention: theirs, or waiting, with customer messages unread. */
export const UnreadSummary = z
  .object({ chats: z.int().nonnegative() })
  .meta({ id: 'UnreadSummary' });
export type UnreadSummary = z.infer<typeof UnreadSummary>;

// ------------------------------------------------------------------ signals on the inbox stream

/**
 * `sla_overdue`: a conversation went past its reply-time target (H12). `chat_offered`: a
 * conversation is offered to this person to accept or decline (HNV-10-03).
 */
export const InboxAlertKind = z.enum([
  'chat_waiting',
  'customer_message',
  'assigned',
  'sla_overdue',
  'chat_offered',
]);
export type InboxAlertKind = z.infer<typeof InboxAlertKind>;

/** Something this person should hear about; sent only to people who may see the chat. */
export const InboxAlertEvent = z
  .object({
    type: z.literal('alert'),
    kind: InboxAlertKind,
    conversationId: typeId('conversation'),
    customerName: z.string(),
    /** The start of the customer's latest message, when there is one. */
    preview: z.string().max(200).nullable(),
    at: Timestamp,
  })
  .meta({ id: 'InboxAlertEvent' });
export type InboxAlertEvent = z.infer<typeof InboxAlertEvent>;

/** The customer is writing (or stopped) in a conversation the person may see. */
export const CustomerTypingSignal = z
  .object({
    type: z.literal('customer_typing'),
    conversationId: typeId('conversation'),
    typing: z.boolean(),
  })
  .meta({ id: 'CustomerTypingSignal' });
export type CustomerTypingSignal = z.infer<typeof CustomerTypingSignal>;

/** The widget tells the conversation that the customer is typing, at most every few seconds. */
export const TypingRequest = z.object({ typing: z.boolean() }).meta({ id: 'TypingRequest' });
