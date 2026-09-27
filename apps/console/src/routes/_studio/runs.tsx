import { createFileRoute } from '@tanstack/react-router';
import { RunsPage } from '../../pages/RunsPage';

export interface RunsSearch {
  run?: string;
  agent?: string;
  outcome?: string;
  conversation?: string;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export const Route = createFileRoute('/_studio/runs')({
  validateSearch: (search: Record<string, unknown>): RunsSearch => {
    const result: RunsSearch = {};
    for (const key of ['run', 'agent', 'outcome', 'conversation'] as const) {
      const value = text(search[key]);
      if (value) result[key] = value;
    }
    return result;
  },
  component: RunsPage,
});
