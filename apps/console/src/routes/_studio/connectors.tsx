import { createFileRoute } from '@tanstack/react-router';
import { ConnectorsPage } from '../../pages/ConnectorsPage';
export const Route = createFileRoute('/_studio/connectors')({ component: ConnectorsPage });
