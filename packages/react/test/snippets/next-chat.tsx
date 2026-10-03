'use client';

import { HamnivoChat } from '@hamnivo/react';

/** useUser stands for the sign-in library of your app. It gives the signed-in user, or null. */
declare function useUser(): { id: string; name: string } | null;

export function Chat() {
  const user = useUser();
  return (
    <HamnivoChat
      widgetId={process.env.NEXT_PUBLIC_HAMNIVO_WIDGET_ID!}
      chatUrl={process.env.NEXT_PUBLIC_HAMNIVO_CHAT_URL!}
      apiUrl={process.env.NEXT_PUBLIC_HAMNIVO_API_URL}
      customer={
        user
          ? {
              key: user.id,
              getAssertion: async () => {
                const response = await fetch('/api/hamnivo/identity', { cache: 'no-store' });
                if (!response.ok) throw new Error('The identity route refused.');
                return ((await response.json()) as { assertion: string }).assertion;
              },
            }
          : null
      }
    />
  );
}
