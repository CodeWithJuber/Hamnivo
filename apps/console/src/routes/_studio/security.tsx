import { createFileRoute } from '@tanstack/react-router';
import { SecurityPage } from '../../pages/security/SecurityPage';

export const Route = createFileRoute('/_studio/security')({
  component: SecurityPage,
});
