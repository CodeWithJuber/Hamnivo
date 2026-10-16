import { createFileRoute } from '@tanstack/react-router';
import { PrivacyPage } from '../../pages/settings/PrivacyPage';

export const Route = createFileRoute('/_studio/settings/privacy')({
  component: PrivacyPage,
});
