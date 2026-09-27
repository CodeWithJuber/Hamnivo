import { createFileRoute } from '@tanstack/react-router';
import { ModelsPage } from '../../pages/ModelsPage';

export const Route = createFileRoute('/_studio/models')({
  component: ModelsPage,
});
