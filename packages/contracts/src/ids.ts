import { z } from 'zod';

/**
 * Public identifiers follow the TypeID specification: `<prefix>_<26-char Crockford base32 UUIDv7>`.
 * Databases store the UUID; the API exposes the prefixed form so an ID's kind is obvious in logs
 * and cannot be confused across resource types. An ID is never authorization by itself.
 */
export const ID_PREFIX = {
  tenant: 'tnt',
  workspace: 'wsp',
  brand: 'brd',
  widget: 'wid',
  conversation: 'conv',
  message: 'msg',
  participant: 'prt',
  event: 'evt',
  request: 'req',
  customer: 'cus',
  session: 'ses',
  staff: 'stf',
  team: 'team',
  upload: 'upl',
  agent: 'agt',
  agentVersion: 'agv',
  run: 'run',
  draft: 'drf',
  decision: 'dcs',
  tool: 'tool',
  action: 'act',
  approval: 'apr',
  operation: 'op',
  receipt: 'rcp',
  source: 'ksrc',
  document: 'doc',
  memory: 'mem',
  memoryDeletion: 'mdel',
  quote: 'quo',
  cart: 'cart',
  order: 'ord',
  handoff: 'hnd',
  task: 'task',
  webhookEndpoint: 'whe',
  webhookDelivery: 'whd',
  apiKey: 'key',
  migration: 'mig',
  invitation: 'inv',
  role: 'role',
  grant: 'grt',
  form: 'form',
  inbox: 'inb',
  secret: 'sec',
  connection: 'acn',
  modelConnection: 'mcn',
  killSwitch: 'ksw',
} as const;

export type IdKind = keyof typeof ID_PREFIX;
export type IdPrefix = (typeof ID_PREFIX)[IdKind];

/** TypeID suffix: 26 lowercase Crockford base32 characters; first char ≤ 7 (128-bit value). */
export const TYPEID_SUFFIX = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export function isTypeId(value: unknown, prefix: IdPrefix): value is string {
  if (typeof value !== 'string') return false;
  const cut = value.lastIndexOf('_');
  return cut > 0 && value.slice(0, cut) === prefix && TYPEID_SUFFIX.test(value.slice(cut + 1));
}

/** Zod schema for a TypeID with the given kind. */
export function typeId<K extends IdKind>(kind: K) {
  const prefix = ID_PREFIX[kind];
  return z
    .string()
    .refine((v) => isTypeId(v, prefix), { message: `Expected a ${prefix}_… identifier` })
    .meta({
      description: `${kind} identifier (TypeID with prefix "${prefix}")`,
      example: `${prefix}_01j9zk7w3xq8r4t2v6m5n1p0cd`,
    });
}

export const TenantId = typeId('tenant');
export const BrandId = typeId('brand');
export const WidgetId = typeId('widget');
export const ConversationId = typeId('conversation');
export const MessageId = typeId('message');
export const EventId = typeId('event');
export const RequestId = typeId('request');
export const CustomerId = typeId('customer');
export const StaffId = typeId('staff');
export const UploadId = typeId('upload');
export const RunId = typeId('run');
export const DraftId = typeId('draft');
export const ActionId = typeId('action');
export const ApprovalId = typeId('approval');
export const SourceId = typeId('source');
export const QuoteId = typeId('quote');
export const OrderId = typeId('order');
export const HandoffId = typeId('handoff');
export const TaskId = typeId('task');
export const ReceiptId = typeId('receipt');
export const FormId = typeId('form');
