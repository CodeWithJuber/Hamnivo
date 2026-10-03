import { createFileRoute } from '@tanstack/react-router';
import { TeamsPage } from '../../pages/settings/TeamsPage';

export const Route = createFileRoute('/_studio/support-teams')({
  component: TeamsPage,
});
