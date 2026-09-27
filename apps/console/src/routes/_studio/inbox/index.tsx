import { createFileRoute } from '@tanstack/react-router';
import { NoConversationPane } from '../../../pages/inbox/InboxPage';

export const Route = createFileRoute('/_studio/inbox/')({
  component: NoConversationPane,
});
