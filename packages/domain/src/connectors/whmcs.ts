/** First-party WHMCS operations. This catalog is the entire remote API allowlist. */
export const WHMCS_CAPABILITIES = [
  'invoices.read',
  'services.read',
  'domains.read',
  'tickets.read',
  'tickets.create',
  'tickets.reply',
  'invoice.payment_url',
  'upgrade.quote',
  'upgrade.request',
  'cancellation.request',
  'refund.handoff',
] as const;
export type WhmcsCapability = (typeof WHMCS_CAPABILITIES)[number];

export const WHMCS_SPEC: Record<
  WhmcsCapability,
  {
    title: string;
    description: string;
    risk: 'read' | 'write' | 'money' | 'irreversible';
    approver: 'customer' | 'staff';
    permission: string;
    api: string | null;
    inputSchema: Record<string, unknown>;
  }
> = {
  'invoices.read': {
    title: 'Read WHMCS invoices',
    description: 'List invoices for the verified client.',
    risk: 'read',
    approver: 'customer',
    permission: 'invoices',
    api: 'GetInvoices',
    inputSchema: object({}),
  },
  'services.read': {
    title: 'Read WHMCS services',
    description: 'List services for the verified client.',
    risk: 'read',
    approver: 'customer',
    permission: 'products',
    api: 'GetClientsProducts',
    inputSchema: object({}),
  },
  'domains.read': {
    title: 'Read WHMCS domains',
    description: 'List domains for the verified client.',
    risk: 'read',
    approver: 'customer',
    permission: 'domains',
    api: 'GetClientsDomains',
    inputSchema: object({}),
  },
  'tickets.read': {
    title: 'Read WHMCS tickets',
    description: 'List tickets for the verified client.',
    risk: 'read',
    approver: 'customer',
    permission: 'tickets',
    api: 'GetTickets',
    inputSchema: object({}),
  },
  'tickets.create': {
    title: 'Create a WHMCS ticket',
    description: 'Open a support ticket after customer confirmation.',
    risk: 'write',
    approver: 'customer',
    permission: 'tickets',
    api: 'OpenTicket',
    inputSchema: object(
      { departmentId: { type: 'integer' }, subject: shortText(200), message: shortText(4000) },
      ['departmentId', 'subject', 'message'],
    ),
  },
  'tickets.reply': {
    title: 'Reply to a WHMCS ticket',
    description: 'Reply to an owned ticket after customer confirmation.',
    risk: 'write',
    approver: 'customer',
    permission: 'tickets',
    api: 'AddTicketReply',
    inputSchema: object({ ticketId: { type: 'integer' }, message: shortText(4000) }, [
      'ticketId',
      'message',
    ]),
  },
  'invoice.payment_url': {
    title: 'Get invoice payment link',
    description: 'Return the official WHMCS invoice page for an owned invoice after confirmation.',
    risk: 'write',
    approver: 'customer',
    permission: 'invoices',
    api: 'GetInvoice',
    inputSchema: object({ invoiceId: { type: 'integer' } }, ['invoiceId']),
  },
  'upgrade.quote': {
    title: 'Quote a WHMCS upgrade',
    description: 'Calculate a live upgrade quote without placing an order.',
    risk: 'read',
    approver: 'customer',
    permission: 'manageproducts',
    api: 'UpgradeProduct',
    inputSchema: object(
      {
        serviceId: { type: 'integer' },
        newProductId: { type: 'integer' },
        billingCycle: shortText(30),
        paymentMethod: shortText(50),
      },
      ['serviceId', 'newProductId', 'billingCycle', 'paymentMethod'],
    ),
  },
  'upgrade.request': {
    title: 'Request a WHMCS upgrade',
    description: 'Place a previously confirmed live quote after staff approval.',
    risk: 'money',
    approver: 'staff',
    permission: 'manageproducts',
    api: 'UpgradeProduct',
    inputSchema: object(
      {
        serviceId: { type: 'integer' },
        newProductId: { type: 'integer' },
        billingCycle: shortText(30),
        paymentMethod: shortText(50),
        quoteId: shortText(100),
      },
      ['serviceId', 'newProductId', 'billingCycle', 'paymentMethod', 'quoteId'],
    ),
  },
  'cancellation.request': {
    title: 'Request WHMCS cancellation',
    description:
      'Submit a cancellation request after approval; service stays active until WHMCS processes it.',
    risk: 'irreversible',
    approver: 'staff',
    permission: 'manageproducts',
    api: 'AddCancelRequest',
    inputSchema: object(
      {
        serviceId: { type: 'integer' },
        type: { type: 'string', enum: ['Immediate', 'End of Billing Period'] },
        reason: shortText(1000),
      },
      ['serviceId', 'type'],
    ),
  },
  'refund.handoff': {
    title: 'Prepare refund handoff',
    description: 'Prepare a staff review packet for a possible refund. No refund API call is made.',
    risk: 'money',
    approver: 'staff',
    permission: 'invoices',
    api: null,
    inputSchema: object({ invoiceId: { type: 'integer' }, reason: shortText(1000) }, [
      'invoiceId',
      'reason',
    ]),
  },
};

function object(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
function shortText(maxLength: number): Record<string, unknown> {
  return { type: 'string', minLength: 1, maxLength };
}

export function whmcsCapability(value: string): value is WhmcsCapability {
  return Object.hasOwn(WHMCS_SPEC, value);
}

/** Reject undocumented or ambiguous permission shapes; a successful API call is not permission. */
export function whmcsPermissions(result: unknown): readonly string[] | null {
  if (!result || typeof result !== 'object') return null;
  const body = result as Record<string, unknown>;
  if (body.result !== 'success') return null;
  const permissions = body.permissions;
  if (!permissions || typeof permissions !== 'object') return null;
  const list = Array.isArray(permissions)
    ? permissions
    : (permissions as Record<string, unknown>).permission;
  return Array.isArray(list) && list.every((value) => typeof value === 'string') ? list : null;
}

export function hasWhmcsPermission(result: unknown, required: string): boolean {
  return whmcsPermissions(result)?.includes(required) ?? false;
}

/** Resource IDs are never accepted as proof of ownership. */
export function ownedByWhmcsClient(result: unknown, clientId: number): boolean {
  if (!result || typeof result !== 'object') return false;
  const body = result as Record<string, unknown>;
  const ids = [body.userid, body.clientid, body.client_id].filter((id) => id !== undefined);
  return (
    body.result === 'success' &&
    ids.length > 0 &&
    ids.every(
      (id) =>
        (typeof id === 'number' || typeof id === 'string') &&
        /^[1-9]\d*$/.test(String(id)) &&
        Number(id) === clientId,
    )
  );
}

export function whmcsSubject(value: string | null): { userId: number; clientId: number } | null {
  const matched = /^whmcs:u:([1-9]\d*):c:([1-9]\d*)$/.exec(value ?? '');
  if (!matched) return null;
  const userId = Number(matched[1]);
  const clientId = Number(matched[2]);
  return Number.isSafeInteger(userId) && Number.isSafeInteger(clientId)
    ? { userId, clientId }
    : null;
}

/** Explicit public fields only: passwords, custom fields, API secrets and staff notes never leave the adapter. */
export function whmcsPublicFields(
  row: Record<string, unknown>,
  fields: readonly string[],
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of fields) {
    const value = row[key];
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      result[key] = value;
    else if (typeof value === 'string') result[key] = value.replace(/<[^>]*>/g, '').slice(0, 1000);
  }
  return result;
}
