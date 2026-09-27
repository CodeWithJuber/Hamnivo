import { createFileRoute } from '@tanstack/react-router';
import { ConversationPane } from '../../../pages/inbox/ConversationPane';

export const Route = createFileRoute('/_studio/inbox/$conversationId')({
  component: ConversationPane,
});
