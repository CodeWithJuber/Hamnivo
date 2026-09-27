import { createFileRoute } from '@tanstack/react-router';
import { ForgotPasswordPage } from '../pages/PasswordPages';

export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordPage,
});
