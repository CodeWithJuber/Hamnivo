import type { AppConfig } from '../config.js';

/**
 * The origins an MCP server may be reached at over plain HTTP and on a private address: none, but
 * for development and tests (TOOLS_EGRESS_ALLOW_PRIVATE, refused in production), which trust the
 * server's own origin. Every other server must be on public HTTPS, like any request made for a
 * tenant (`@hamnivo/adapters/net`).
 */
export function mcpTrustedOrigins(
  config: Pick<AppConfig, 'TOOLS_EGRESS_ALLOW_PRIVATE'>,
  serverUrl: string,
): string[] {
  if (!config.TOOLS_EGRESS_ALLOW_PRIVATE) return [];
  try {
    return [new URL(serverUrl).origin];
  } catch {
    return [];
  }
}
