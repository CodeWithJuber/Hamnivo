import type { EvidenceStatus, MemoryKind, MemorySensitivity } from './envelope.js';

/**
 * The closed catalogue of what customer memory may hold. A model can only propose values for
 * these slots; everything that governs a record (kind, scope, purpose, sensitivity, retention)
 * comes from here, never from the proposal (L07).
 */
export interface MemorySlot {
  key: string;
  kind: MemoryKind;
  /** English label, used in prompts and as the default interface text. */
  label: string;
  /** Why it is kept, as shown to the customer and staff. */
  purpose: string;
  /** What the model should look for (extraction instructions). */
  description: string;
  sensitivity: MemorySensitivity;
  retentionDays: number;
  /** `person`: this customer, across chats. `conversation`: only the chat it came from. */
  scope: 'person' | 'conversation';
  maxLength: number;
  /** Recalled for every reply while memory is on, whatever the question. */
  profile: boolean;
  /** The conversational model may propose it. */
  extractable: boolean;
  /** Evidence status of new records: claims stay unknown until a system of record confirms them. */
  evidence: EvidenceStatus;
}

const slot = (value: MemorySlot) => value;

export const MEMORY_SLOTS = {
  preferred_language: slot({
    key: 'preferred_language',
    kind: 'preference',
    label: 'Preferred language',
    purpose: 'Reply in the language the customer prefers',
    description: 'The language the customer asked to be answered in, such as Urdu or English.',
    sensitivity: 'normal',
    retentionDays: 365,
    scope: 'person',
    maxLength: 40,
    profile: true,
    extractable: true,
    evidence: 'supported',
  }),
  preferred_name: slot({
    key: 'preferred_name',
    kind: 'preference',
    label: 'Preferred name',
    purpose: 'Address the customer the way they asked',
    description: 'The name or form of address the customer asked to be called by.',
    sensitivity: 'personal',
    retentionDays: 365,
    scope: 'person',
    maxLength: 60,
    profile: true,
    extractable: true,
    evidence: 'supported',
  }),
  contact_method: slot({
    key: 'contact_method',
    kind: 'preference',
    label: 'Contact preference',
    purpose: 'Use the contact method the customer prefers',
    description: 'How the customer prefers to be contacted: email, phone call, SMS or WhatsApp.',
    sensitivity: 'normal',
    retentionDays: 365,
    scope: 'person',
    maxLength: 80,
    profile: true,
    extractable: true,
    evidence: 'supported',
  }),
  contact_time: slot({
    key: 'contact_time',
    kind: 'preference',
    label: 'Best time to reach',
    purpose: 'Contact the customer at a time that suits them',
    description: 'When the customer prefers to be contacted, such as "after 6 pm".',
    sensitivity: 'normal',
    retentionDays: 365,
    scope: 'person',
    maxLength: 80,
    profile: false,
    extractable: true,
    evidence: 'supported',
  }),
  communication_style: slot({
    key: 'communication_style',
    kind: 'preference',
    label: 'Reply style',
    purpose: 'Reply the way the customer prefers',
    description: 'How the customer wants replies written, such as short or detailed.',
    sensitivity: 'normal',
    retentionDays: 365,
    scope: 'person',
    maxLength: 80,
    profile: true,
    extractable: true,
    evidence: 'supported',
  }),
  delivery_note: slot({
    key: 'delivery_note',
    kind: 'preference',
    label: 'Delivery note',
    purpose: 'Ensure smooth delivery',
    description: 'Standing delivery instructions, such as "leave the parcel with reception".',
    sensitivity: 'personal',
    retentionDays: 180,
    scope: 'person',
    maxLength: 200,
    profile: false,
    extractable: true,
    evidence: 'supported',
  }),
  product_interest: slot({
    key: 'product_interest',
    kind: 'preference',
    label: 'Product interest',
    purpose: 'Suggest products the customer asked about',
    description: 'Products or categories the customer said they are interested in.',
    sensitivity: 'normal',
    retentionDays: 180,
    scope: 'person',
    maxLength: 120,
    profile: false,
    extractable: true,
    evidence: 'supported',
  }),
  size_preference: slot({
    key: 'size_preference',
    kind: 'preference',
    label: 'Size',
    purpose: 'Suggest the right size',
    description: 'The clothing or shoe size the customer said they wear.',
    sensitivity: 'normal',
    retentionDays: 365,
    scope: 'person',
    maxLength: 60,
    profile: false,
    extractable: true,
    evidence: 'supported',
  }),
  open_issue: slot({
    key: 'open_issue',
    kind: 'observation',
    label: 'Open request',
    purpose: 'Continue an unresolved request without asking again',
    description: 'A problem the customer reported that is not resolved yet, in a few words.',
    sensitivity: 'normal',
    retentionDays: 30,
    scope: 'person',
    maxLength: 200,
    profile: false,
    extractable: true,
    evidence: 'unknown',
  }),
  stated_order_reference: slot({
    key: 'stated_order_reference',
    kind: 'claim',
    label: 'Order the customer mentioned',
    purpose: 'Find the customer’s order faster',
    description: 'An order number the customer gave. It is their claim, not a verified order.',
    sensitivity: 'normal',
    retentionDays: 30,
    scope: 'person',
    maxLength: 40,
    profile: false,
    extractable: true,
    evidence: 'unknown',
  }),
} as const satisfies Record<string, MemorySlot>;

export type MemorySlotKey = keyof typeof MEMORY_SLOTS;
export const MEMORY_SLOT_KEYS = Object.keys(MEMORY_SLOTS) as MemorySlotKey[];

export function isMemorySlot(key: string): key is MemorySlotKey {
  return Object.hasOwn(MEMORY_SLOTS, key);
}

export function memorySlot(key: string): MemorySlot | null {
  return isMemorySlot(key) ? MEMORY_SLOTS[key] : null;
}
