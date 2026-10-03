import { useHamnivo } from '@hamnivo/react';

export function ChatButton() {
  const { loaded, unread, open } = useHamnivo();
  return (
    <button type="button" onClick={open} disabled={!loaded}>
      Chat with us{unread > 0 ? ` (${unread} new)` : ''}
    </button>
  );
}
