import { createFileRoute } from '@tanstack/react-router';
import { ChatWidgetPage } from '../../pages/chat-widget/ChatWidgetPage';

/** The parts of a brand's chat, one tab each. */
export const CHAT_WIDGET_TABS = ['look', 'behaviour', 'forms', 'privacy', 'share'] as const;
export type ChatWidgetTab = (typeof CHAT_WIDGET_TABS)[number];

export interface ChatWidgetSearch {
  /** brd_… */
  brand?: string;
  tab?: ChatWidgetTab;
}

export const Route = createFileRoute('/_studio/chat-widget')({
  validateSearch: (search: Record<string, unknown>): ChatWidgetSearch => ({
    ...(typeof search.brand === 'string' && search.brand
      ? { brand: search.brand.slice(0, 64) }
      : {}),
    ...((CHAT_WIDGET_TABS as readonly unknown[]).includes(search.tab)
      ? { tab: search.tab as ChatWidgetTab }
      : {}),
  }),
  component: ChatWidgetPage,
});
