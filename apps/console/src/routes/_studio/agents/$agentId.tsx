import { createFileRoute } from '@tanstack/react-router';
import { AgentEditorPage } from '../../../pages/AgentEditorPage';

export const Route = createFileRoute('/_studio/agents/$agentId')({
  component: AgentEditorPage,
});
