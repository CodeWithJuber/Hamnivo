import { createFileRoute } from '@tanstack/react-router';
import { ToolsPage } from '../../pages/ToolsPage';

export interface ToolsSearch {
  brand?: string;
  /** The tool open in the inspector drawer. */
  tool?: string;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export const Route = createFileRoute('/_studio/tools')({
  validateSearch: (search: Record<string, unknown>): ToolsSearch => {
    const result: ToolsSearch = {};
    const brand = text(search.brand);
    const tool = text(search.tool);
    if (brand) result.brand = brand;
    if (tool) result.tool = tool;
    return result;
  },
  component: ToolsPage,
});
