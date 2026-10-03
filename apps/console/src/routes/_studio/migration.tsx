import { createFileRoute } from '@tanstack/react-router';
import { MigrationPage } from '../../pages/MigrationPage';

export interface MigrationSearch {
  job?: string;
}

export const Route = createFileRoute('/_studio/migration')({
  validateSearch: (search: Record<string, unknown>): MigrationSearch =>
    typeof search.job === 'string' && search.job ? { job: search.job } : {},
  component: MigrationPage,
});
