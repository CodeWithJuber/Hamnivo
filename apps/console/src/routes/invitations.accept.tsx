import { createFileRoute } from '@tanstack/react-router';
import { InvitationPage } from '../pages/InvitationPage';

export interface InvitationSearch {
  token?: string;
}

/** The link in an invitation email (A02): accept it while signed in with the invited address. */
export const Route = createFileRoute('/invitations/accept')({
  validateSearch: (search: Record<string, unknown>): InvitationSearch =>
    typeof search.token === 'string' && search.token.length <= 200 ? { token: search.token } : {},
  component: InvitationPage,
});
