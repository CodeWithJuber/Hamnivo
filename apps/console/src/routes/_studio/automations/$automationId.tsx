import { createFileRoute } from '@tanstack/react-router';
import { AutomationEditorPage } from '../../../pages/automations/AutomationEditorPage';

export const Route = createFileRoute('/_studio/automations/$automationId')({
  component: AutomationEditorPage,
});
