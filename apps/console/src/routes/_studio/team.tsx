import { createFileRoute } from '@tanstack/react-router';
import { TeamPage } from '../../pages/team/TeamPage';

export type TeamTab = 'members' | 'roles' | 'audit';

export interface TeamSearch {
  tab?: TeamTab;
  /** The role open in the editor, or `new`. */
  role?: string;
  q?: string;
}

export const Route = createFileRoute('/_studio/team')({
  validateSearch: (search: Record<string, unknown>): TeamSearch => ({
    ...(search.tab === 'roles' || search.tab === 'audit' ? { tab: search.tab } : {}),
    ...(typeof search.role === 'string' && search.role ? { role: search.role } : {}),
    ...(typeof search.q === 'string' && search.q ? { q: search.q } : {}),
  }),
  component: TeamPage,
});
