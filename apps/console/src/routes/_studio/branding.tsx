import { createFileRoute } from '@tanstack/react-router';
import { BrandingPage } from '../../pages/BrandingPage';
export const Route = createFileRoute('/_studio/branding')({ component: BrandingPage });
