import { useConversationStream, useHamnivoClient, useOutbox } from '@hamnivo/react/client';
import { useState } from 'react';

export function MyChat({ conversationId }: { conversationId: string }) {
  const { client, status } = useHamnivoClient({
    apiBase: 'https://api.example.com',
    widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
  });
  const ready = status === 'ready' ? client : null;

  // What the visitor typed, with its honest state: queued, sending, accepted or failed.
  const { messages, send, retry } = useOutbox(ready, conversationId);

  // What the conversation sends back, live, in order, once each.
  const [events, setEvents] = useState<string[]>([]);
  useConversationStream(ready, conversationId, {
    onEvent: (event) => setEvents((list) => [...list, `${event.sequence}: ${event.type}`]),
    onResync: () => {
      // The stream fell too far behind: load the history again with client.history().
    },
  });

  return (
    <div>
      <ul>
        {messages.map((message) => (
          <li key={message.clientMessageId}>
            {message.text} ({message.state})
            {message.state === 'failed' && (
              <button type="button" onClick={() => retry(message.clientMessageId)}>
                Try again
              </button>
            )}
          </li>
        ))}
      </ul>
      <ul>
        {events.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <button type="button" disabled={!ready} onClick={() => send('Where is my order?')}>
        Ask
      </button>
    </div>
  );
}
