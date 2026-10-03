import { HamnivoChat } from '@hamnivo/react';
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <HamnivoChat
          widgetId={process.env.NEXT_PUBLIC_HAMNIVO_WIDGET_ID!}
          chatUrl={process.env.NEXT_PUBLIC_HAMNIVO_CHAT_URL!}
          apiUrl={process.env.NEXT_PUBLIC_HAMNIVO_API_URL}
        />
      </body>
    </html>
  );
}
