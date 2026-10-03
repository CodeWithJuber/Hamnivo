import { createFileRoute } from '@tanstack/react-router';
import { VisitorsPage } from '../../pages/visitors/VisitorsPage';

export const Route = createFileRoute('/_studio/visitors')({
  component: VisitorsPage,
});
