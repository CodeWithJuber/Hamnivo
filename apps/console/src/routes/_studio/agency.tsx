import { createFileRoute } from '@tanstack/react-router';
import { AgencyPage } from '../../pages/AgencyPage';
export const Route = createFileRoute('/_studio/agency')({ component: AgencyPage });
