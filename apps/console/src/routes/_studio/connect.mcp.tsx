import { createFileRoute } from '@tanstack/react-router';
import { ConnectMcpPage } from '../../pages/ConnectMcpPage';

/**
 * Where a service's sign-in page sends the browser back to (the MCP authorization spec). The
 * answer is in the address; the page passes it on once and removes it from the address bar.
 */
export interface ConnectMcpSearch {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  iss?: string;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export const Route = createFileRoute('/_studio/connect/mcp')({
  validateSearch: (search: Record<string, unknown>): ConnectMcpSearch => {
    const result: ConnectMcpSearch = {};
    for (const key of ['code', 'state', 'error', 'error_description', 'iss'] as const) {
      const value = text(search[key]);
      if (value) result[key] = value;
    }
    return result;
  },
  component: ConnectMcpPage,
});
