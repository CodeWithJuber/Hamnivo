import { checkDestination, checkUrl, EgressError } from '@hamnivo/adapters/net';
import type { TenantTx } from '@hamnivo/db';
import { AppError } from '../../common/app-error.js';
import type { AppConfig } from '../../config.js';
import type { EgressService } from '../../developer/egress.service.js';
import { mcpTrustedOrigins } from '../mcp-origins.js';

/**
 * The checks on an address a person gives for custom HTTP tools (X05, D10): the address itself
 * (HTTPS, no credentials, public), and the workspace's side of it (its allowed hosts, and a name
 * that resolves to a private network). A refusal is the answer for one field of the form.
 */

/** The words for an address the egress guard refuses, as the field's error. */
export function refused(error: unknown, field: string): never {
  const message =
    error instanceof EgressError
      ? error.problem === 'host_not_allowed'
        ? 'This host is not on the list of allowed hosts. Add it under Allowed hosts first.'
        : error.message
      : 'Enter the full web address, starting with https://.';
  throw new AppError('VALIDATION_FAILED', { detail: message, fields: [{ path: field, message }] });
}

/** The address of a service: web, public, and only what every request shares (no ? and no #). */
export function checkServiceAddress(
  config: Pick<AppConfig, 'TOOLS_EGRESS_ALLOW_PRIVATE'>,
  url: string,
  field: string,
): void {
  try {
    const parsed = new URL(url);
    if (parsed.search || parsed.hash) {
      const message = 'Leave out the ? and # parts: enter only the address every request shares.';
      throw new AppError('VALIDATION_FAILED', {
        detail: message,
        fields: [{ path: field, message }],
      });
    }
    checkUrl(url, { trustedOrigins: mcpTrustedOrigins(config, url) });
  } catch (error) {
    if (error instanceof AppError) throw error;
    refused(error, field);
  }
}

/**
 * The workspace's side of an address: its allowed hosts, and a name that resolves to a private
 * network is refused now. A name that does not resolve yet is accepted: it is checked again,
 * with the same rules, whenever a tool calls it.
 */
export async function checkWorkspaceSide(
  egress: EgressService,
  config: Pick<AppConfig, 'TOOLS_EGRESS_ALLOW_PRIVATE'>,
  tx: TenantTx,
  url: string,
  field: string,
): Promise<void> {
  try {
    await checkDestination(url, await egress.policyIn(tx, mcpTrustedOrigins(config, url)));
  } catch (error) {
    if (error instanceof EgressError && error.problem === 'unresolvable') return;
    refused(error, field);
  }
}
