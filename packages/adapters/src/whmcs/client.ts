import { EgressError, type EgressPolicy, safeRequest } from '../net/index.js';

/** The only WHMCS API verbs the native adapter may send. */
export const WHMCS_ACTIONS = [
  'GetUserPermissions',
  'GetInvoices',
  'GetInvoice',
  'GetClientsProducts',
  'GetClientsDomains',
  'GetTickets',
  'GetTicket',
  'OpenTicket',
  'AddTicketReply',
  'UpgradeProduct',
  'AddCancelRequest',
  'GetCurrencies',
] as const;
export type WhmcsAction = (typeof WHMCS_ACTIONS)[number];

export class WhmcsApiError extends Error {
  override readonly name = 'WhmcsApiError';
  constructor(
    readonly kind: 'network' | 'timeout' | 'http' | 'response' | 'rejected' | 'egress',
    readonly mayHaveApplied: boolean,
  ) {
    super('The WHMCS request could not be confirmed.');
  }
}

export interface WhmcsCredentials {
  identifier: string;
  secret: string;
}
export interface WhmcsRequest {
  baseUrl: string;
  credentials: WhmcsCredentials;
  action: WhmcsAction;
  fields?: Readonly<Record<string, string | number | boolean>>;
  policy: EgressPolicy;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const WRITE_ACTIONS = new Set<WhmcsAction>([
  'OpenTicket',
  'AddTicketReply',
  'UpgradeProduct',
  'AddCancelRequest',
]);

/** Uses WHMCS's supported external API; the guarded client rejects redirects and private hosts. */
export async function callWhmcs(input: WhmcsRequest): Promise<Record<string, unknown>> {
  if (!WHMCS_ACTIONS.includes(input.action)) throw new WhmcsApiError('rejected', false);
  const url = new URL(input.baseUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new WhmcsApiError('egress', false);
  }
  const body = new URLSearchParams({
    action: input.action,
    identifier: input.credentials.identifier,
    secret: input.credentials.secret,
    responsetype: 'json',
  });
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (
      !/^[a-z][a-z0-9_]*$/i.test(key) ||
      ['action', 'identifier', 'secret', 'username', 'password', 'responsetype'].includes(
        key.toLowerCase(),
      )
    ) {
      throw new WhmcsApiError('rejected', false);
    }
    body.set(key, String(value));
  }
  const writes = WRITE_ACTIONS.has(input.action) && input.fields?.calconly !== true;
  let response: Awaited<ReturnType<typeof safeRequest>>;
  try {
    response = await safeRequest(
      {
        url: new URL('/includes/api.php', url).toString(),
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        timeoutMs: input.timeoutMs ?? 10000,
        maxResponseBytes: 64 * 1024,
        signal: input.signal,
      },
      input.policy,
    );
  } catch (error) {
    if (error instanceof EgressError) {
      throw new WhmcsApiError(
        error.problem === 'timeout'
          ? 'timeout'
          : error.problem === 'network'
            ? 'network'
            : 'egress',
        writes &&
          ['timeout', 'network', 'response_too_large', 'redirect', 'tls'].includes(error.problem),
      );
    }
    throw new WhmcsApiError('network', writes);
  }
  if (response.status !== 200 || response.truncated) throw new WhmcsApiError('http', writes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new WhmcsApiError('response', writes);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new WhmcsApiError('response', writes);
  const result = parsed as Record<string, unknown>;
  if (result.result === 'error') throw new WhmcsApiError('rejected', false);
  if (result.result !== 'success') throw new WhmcsApiError('response', writes);
  return result;
}
