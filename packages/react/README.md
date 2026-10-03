# @hamnivo/react

Hamnivo Chat for React and Next.js.

- `HamnivoChat`: a component that puts the chat on your site and renders nothing itself.
- `useHamnivo()`: the state of the chat window (loaded, open, unread, verified) and its controls.
- `@hamnivo/react/client`: hooks for building your own chat on the headless SDK
  [`@hamnivo/client`](../client): `useHamnivoClient`, `useOutbox` and `useConversationStream`.

It loads the same `loader.js` as the install code of Hamnivo Studio, so you need the same widget ID,
chat address and API address, and your app's address on the brand's allowed websites. The full guide,
with every prop, signed-in customers and Next.js, is
[`docs/guide/integrations/react-vue-next.md`](../../docs/guide/integrations/react-vue-next.md).

```bash
npm install @hamnivo/react     # React 18.2 or newer
```

```tsx
import { HamnivoChat } from '@hamnivo/react';

export function App() {
  return (
    <>
      {/* The rest of your app */}
      <HamnivoChat
        widgetId="wid_01j9zk7w3xq8r4t2v6m5n1p0ce"
        chatUrl="https://chat.example.com"
        apiUrl="https://api.example.com"
      />
    </>
  );
}
```

## Next.js

The files start with `"use client"`, so a server component, such as the root layout of the App
Router, can render the component:

```tsx
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
```

For signed-in customers, pass `customer={{ key, getAssertion }}` from a client component and sign the
assertion in a route handler with [`@hamnivo/server`](../server-sdk). The guide has both files.

## Good to know

- The loader starts once per page and cannot be taken apart. The settings are read when the chat
  first appears. When the last `HamnivoChat` unmounts, the chat is closed and hidden, and it comes
  back when one mounts again.
- Nothing runs on the server, and React's strict mode adds one script, not two.
- With `customer`, the chat identifies the signed-in customer, identifies the next one when `key`
  changes, and is signed out when the customer goes, also after a reload.
- `@hamnivo/react/client` needs `@hamnivo/client` next to it, which is not published yet. The rest
  of the package does not.

## Develop

```bash
pnpm --filter @hamnivo/react test       # builds, then runs the tests in a real React
pnpm --filter @hamnivo/react typecheck  # the package, the tests and the snippets of the guide
```

`src/embed.ts` has no framework in it and is an identical copy of the one in
[`@hamnivo/vue`](../vue): a test fails if they differ. A tag named `react-v<version>` publishes the
package, see
[`.github/workflows/release-packages.yml`](../../.github/workflows/release-packages.yml).
