import { createFileRoute } from '@tanstack/react-router';
import { AgentsPage } from '../../../pages/AgentsPage';

export const Route = createFileRoute('/_studio/agents/')({
  component: AgentsPage,
});
