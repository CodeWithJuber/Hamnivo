# Hamnivo Chat for React, Vue and Next.js

This guide is for developers. It adds Hamnivo Chat to a React, Next.js or Vue app with a component,
and gives you hooks to control the chat window, and, for React, to build your own chat on
[`@hamnivo/client`](../../../packages/client).

The component puts the same loader script on your page that the install code of Hamnivo Studio
does, so you need the same three things: the **widget ID**, the **chat address** and the **API
address**, and your app's address on the brand's **allowed websites** list.
[Where to find them, and how to allow your site](README.md#what-every-guide-asks-for).

## Install

```bash
npm install @hamnivo/react     # React 18.2 or newer, and Next.js
npm install @hamnivo/vue       # Vue 3.3 or newer, and Nuxt
```

Both are plain ES modules with types, and have no dependencies of their own. The packages are
published from the Hamnivo repository when a release is tagged.

## React

Render the chat once, high in your tree:

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

`HamnivoChat` renders nothing itself. Its props:

| Prop | What it does |
|---|---|
| `widgetId` | Required. The brand's widget ID, `wid_…`. |
| `chatUrl` | Required. Where Hamnivo Chat runs. Only its origin is used. It may be `http://` for a Hamnivo on your own computer. |
| `apiUrl` | The Hamnivo API. Without it the loader uses its own defaults. |
| `locale` | `en`, `ar`, `hi` or `ur`. Your page's `lang` by default. |
| `mode`, `position`, `color` | Replace the layout, the side and the launcher colour the brand chose in Studio. |
| `container`, `height` | For the `inline` mode: the element to put the chat in, and its height. |
| `labels` | Accessible names: `{ open, close, title }`. |
| `theme` | `light`, `dark` or `auto`. Without it the brand's choice applies; `auto` follows your page: its background first, then the colour scheme it declares. The visitor's device alone never turns the chat dark. |
| `offset`, `launcher`, `zIndex` | Where the launcher sits and how it looks: `{ x, y }` in pixels from the side and the bottom, `{ size: 'small' \| 'medium' \| 'large', icon: 'chat' \| 'message' \| 'help' \| 'sparkle' }`, and its stacking order for pages with overlays of their own. |
| `hideOn`, `hideOnMobile` | Pages the chat is kept off, as paths that are exact or end in a star (`['/checkout*']`), and `true` to keep the launcher off phones. On a single-page app the paths are checked again on every navigation. |
| `nonce` | The nonce of your Content-Security-Policy, if it needs one for scripts and styles. |
| `customer` | The signed-in customer: see [Signed-in customers](#signed-in-customers). |
| `onReady`, `onError` | Called when the loader has started, and when it cannot, or when telling the chat who is signed in fails. Without `onError`, the message goes to the console. |

Things to know:

- **The loader starts once per page** and cannot be taken apart. So the settings are read when the
  chat first appears, later changes to them are ignored, and two `HamnivoChat` give one chat. If
  you ask for a different widget ID or address after it started, a warning on the console says so.
- **Unmounting hides, it does not remove.** When the last `HamnivoChat` unmounts, the chat is closed
  and hidden. It comes back when one mounts again. So you can render it only on the pages that
  should have it.
- **It is safe on the server.** Nothing runs until the page is in the browser. React's strict mode,
  which runs effects twice in development, adds one script, not two.
- **If you also paste the install code** into the page, nothing breaks: the loader starts once.

### Control the chat window

`useHamnivo()` gives the state of the chat and the controls, to any component:

```tsx
import { useHamnivo } from '@hamnivo/react';

export function ChatButton() {
  const { loaded, unread, open } = useHamnivo();
  return (
    <button type="button" onClick={open} disabled={!loaded}>
      Chat with us{unread > 0 ? ` (${unread} new)` : ''}
    </button>
  );
}
```

| | |
|---|---|
| `loaded` | The loader has started, so the controls work. |
| `isOpen` | The chat window is open. Only the `bubble` and `panel` layouts open and close. |
| `unread` | Replies that wait while the chat is closed. |
| `verified` | This page told the chat who the visitor is, and the chat accepted it. |
| `open()`, `close()`, `toggle()` | Act on the window. Before the chat is loaded they do nothing. |
| `identify(assertion)`, `reset()` | Tell the chat who the visitor is, or sign them out. They wait for the chat if it is loading, and fail if nothing is loading it. |

The state is the same in every component. On the server it is the state of a page where the chat has
not loaded. The functions are the same on every render, so they are safe in dependency lists.

### Signed-in customers

Pass `customer` when your app knows who is signed in. The chat asks `getAssertion` for a fresh
assertion, signed by your server, and identifies them, so they see their own conversations on any
device. When `key` changes it identifies the new customer. When the customer goes (`null`) the chat
is signed out, and so is a browser that was verified before this page loaded, so the next person on
a shared computer starts anonymous.

Keep `key` stable, for example the user's ID: it is how a change is noticed. `getAssertion` can be a
new function on every render: the latest one is called. If you call `identify` and `reset` yourself
instead, you own signing out too.

The server side signs with [`@hamnivo/server`](../../../packages/server-sdk) and an identity key.
Registering the key is a one-time job: [the steps](../../guides/identity.md). A full example for
Next.js follows.

### Build your own chat

If you do not want the ready-made chat window, `@hamnivo/react/client` has hooks on the headless
SDK [`@hamnivo/client`](../../../packages/client), which you install next to it:

```bash
npm install @hamnivo/react @hamnivo/client
```

- `useHamnivoClient(options)` opens the visitor's session and gives `{ client, status, session, error, retry }`.
  It makes a new client only when `apiBase`, `widgetId`, `hostOrigin`, `locale`, `storage` or `fetch`
  change, so keep `storage` and `fetch` stable. `hostOrigin` is your page's origin if you leave it
  out, and must be one of the brand's allowed websites.
- `useOutbox(client, conversationId)` gives `{ messages, send, retry, remove, settle, flush }`. A
  message is sent once, in order, with an honest state (queued, sending, accepted or failed), and
  unsent messages survive a reload.
- `useConversationStream(client, conversationId, handlers, options)` follows a conversation live. It
  hands over events in order, once each, reconnects where it stopped, renews the session when it
  expires, and calls `onResync` when you must load the history again. The handlers can be new
  functions on every render.

```tsx
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
```

The rest of the SDK (`client.startConversation()`, `client.history()`, files, drafts, read marks) is
in the [client's README](../../../packages/client/README.md).

## Next.js

`@hamnivo/react` marks its files `"use client"`, so you can render the component straight from a
server component such as the root layout of the App Router.

1. Put the three values in `.env.local`. The `NEXT_PUBLIC_` ones are meant for the browser:

   ```bash
   NEXT_PUBLIC_HAMNIVO_WIDGET_ID=wid_…
   NEXT_PUBLIC_HAMNIVO_CHAT_URL=https://chat.example.com
   NEXT_PUBLIC_HAMNIVO_API_URL=https://api.example.com
   ```

2. Render the chat in `app/layout.tsx`:

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

With the Pages Router, render it in `pages/_app.tsx` in the same way. With a Content-Security-Policy
that uses nonces, pass `nonce` too, and allow the chat address in `script-src` and `frame-src`, and
the API address in `connect-src`.

### Next.js with signed-in customers

Three pieces, and none of them sends anything about the customer from the browser:

1. **A route that signs.** It reads the signed-in user from your session, never from the request,
   and answers with a fresh assertion. Put the key in server-only environment variables (no
   `NEXT_PUBLIC_`), and give a customer's email only if your app confirms email addresses
   (`emailVerified`). `app/api/hamnivo/identity/route.ts`:

```ts
import { createIdentityAssertion } from '@hamnivo/server';

/** getUser stands for how your app reads the signed-in user from a request. */
declare function getUser(
  request: Request,
): Promise<{ id: string; name: string; email: string; emailVerified: boolean } | null>;

export async function GET(request: Request): Promise<Response> {
  const user = await getUser(request);
  if (!user) return new Response(null, { status: 401 });
  const assertion = await createIdentityAssertion({
    widgetId: process.env.HAMNIVO_WIDGET_ID!,
    key: {
      kid: process.env.HAMNIVO_IDENTITY_KID!,
      alg: 'HS256',
      secret: process.env.HAMNIVO_IDENTITY_SECRET!,
    },
    customer: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
    },
  });
  return Response.json({ assertion }, { headers: { 'cache-control': 'no-store' } });
}
```

2. **A client component** that passes the signed-in user to the chat. `app/chat.tsx`:

```tsx
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
```

3. **The layout** renders `<Chat />` instead of `<HamnivoChat />`.

The route answers `401` to a visitor who is signed out, and the chat stays anonymous. Sign a new
assertion for every call: Hamnivo accepts each one once. The route is not cached because of the
`cache-control` header and the `cache: 'no-store'` in the client component.

## Vue

Install the plugin once. It keeps your settings in one place and registers `HamnivoChat` in every
component:

```ts
import { createHamnivo } from '@hamnivo/vue';
import { createApp } from 'vue';
import App from './App.vue';

createApp(App)
  .use(
    createHamnivo({
      widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chatUrl: 'https://chat.example.com',
      apiUrl: 'https://api.example.com',
    }),
  )
  .mount('#app');
```

Then render the component once, in your root component. It needs no props:

```vue
<template>
  <RouterView />
  <HamnivoChat />
</template>
```

`HamnivoChat` takes the same props as the React component, written the way a template writes them
(`chat-url`, `api-url`, `widget-id`, and so on). A prop replaces the same option of the plugin. It
emits `ready` with the chat when the loader has started, and `error` with an `Error` when it cannot,
or when telling the chat who is signed in fails. Without an `@error` listener, the message goes to the
console. The things to know for React above are true for Vue too: one chat per page, hidden and not
removed when the last component unmounts, and nothing runs on the server.

### Control the chat window, and signed-in customers

`useHamnivo()` gives refs and controls:

```vue
<script setup lang="ts">
import { useHamnivo } from '@hamnivo/vue';

const { loaded, unread, open } = useHamnivo();
</script>

<template>
  <button type="button" :disabled="!loaded" @click="open">
    Chat with us <span v-if="unread > 0">({{ unread }} new)</span>
  </button>
</template>
```

`loaded`, `isOpen`, `unread` and `verified` are refs. `open`, `close`, `toggle`, `identify` and `reset`
are the same functions as in React. In a component the refs follow the chat while it is mounted. In a
store or any other scope, they follow it until the scope stops.

Pass `customer` for signed-in customers, with a `key` and a `getAssertion`, exactly as in React. The
route that signs is the same one as in the Next.js section above, or any route of your server
that uses `@hamnivo/server`:

```vue
<script setup lang="ts">
import { HamnivoChat } from '@hamnivo/vue';
import { useUser } from './auth'; // your sign-in code: the signed-in user, or null

const user = useUser();

async function getAssertion() {
  const response = await fetch('/api/hamnivo/identity', { cache: 'no-store' });
  if (!response.ok) throw new Error('The identity route refused.');
  return ((await response.json()) as { assertion: string }).assertion;
}
</script>

<template>
  <HamnivoChat :customer="user ? { key: user.id, getAssertion } : null" />
</template>
```

### Nuxt

Register the plugin in a plugin that runs in the browser only, for example
`plugins/hamnivo.client.ts`, and put the settings in `runtimeConfig.public`:

```ts
import { createHamnivo } from '@hamnivo/vue';

export default defineNuxtPlugin((nuxtApp) => {
  const { hamnivoWidgetId, hamnivoChatUrl, hamnivoApiUrl } = useRuntimeConfig().public;
  nuxtApp.vueApp.use(
    createHamnivo({ widgetId: hamnivoWidgetId, chatUrl: hamnivoChatUrl, apiUrl: hamnivoApiUrl }),
  );
});
```

Then put `<HamnivoChat />` in `app.vue`.

## Without a framework

Both packages export `loadHamnivo(options)`, which adds the loader script once and resolves with
`window.Hamnivo`. For a page that is not a React or Vue app, use the [plain HTML guide](html.md).

---

## How it is built and released

- The two packages are in [`packages/react`](../../../packages/react) and
  [`packages/vue`](../../../packages/vue). Each carries an identical copy of the file that loads and
  follows the chat (`src/embed.ts`), and a test fails if they differ.
- **Tests.** `pnpm exec turbo run typecheck test --filter=@hamnivo/react --filter=@hamnivo/vue
  --concurrency=1` builds each package and what it needs, then runs the tests in a real React and a
  real Vue, against a stand-in for the loader: the loading, the hiding, the identity flow with its
  sign-out ordering, the hooks, and, for React, the hooks on the client against a stand-in for the
  Hamnivo API. They also check the published files: the `"use client"` line, the imports, the
  exports. The Next.js and React snippets in this guide are type-checked with the package.
- **Release.** Push a tag named `react-v` or `vue-v` followed by the version in the package's
  `package.json`, for example `react-v0.1.0`. [`release-packages.yml`](../../../.github/workflows/release-packages.yml)
  checks the tag against the package, runs its checks, and publishes it to npm with
  trusted publishing: no npm token is stored anywhere, and each version carries a provenance
  statement that links it to the commit and the run that built it. Once per package, the owner names the
  workflow under the package's **Settings → Trusted publishing** on npmjs.com (owner
  `CodeWithJuber`, repository `Hamnivo`, workflow `release-packages.yml`, environment `npm`).
- `@hamnivo/react/client` needs `@hamnivo/client`, which is not published yet. The rest of
  `@hamnivo/react` does not need it.
