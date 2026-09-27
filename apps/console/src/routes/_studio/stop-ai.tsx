import { createFileRoute } from '@tanstack/react-router';
import { StopAiPage } from '../../pages/StopAiPage';

export const Route = createFileRoute('/_studio/stop-ai')({
  component: StopAiPage,
});
