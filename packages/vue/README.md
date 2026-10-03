# @hamnivo/vue

Hamnivo Chat for Vue 3 and Nuxt.

- `createHamnivo(options)`: a plugin that keeps your settings in one place and registers
  `HamnivoChat` in every component.
- `HamnivoChat`: a component that puts the chat on your site and renders nothing itself.
- `useHamnivo()`: the state of the chat window (`loaded`, `isOpen`, `unread`, `verified`) as refs,
  and its controls.

It loads the same `loader.js` as the install code of Hamnivo Studio, so you need the same widget ID,
chat address and API address, and your app's address on the brand's allowed websites. The full guide,
with every prop, signed-in customers and Nuxt, is
[`docs/guide/integrations/react-vue-next.md`](../../docs/guide/integrations/react-vue-next.md).

```bash
npm install @hamnivo/vue     # Vue 3.3 or newer
```

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

Then render `<HamnivoChat />` once, in your root component. It needs no props, and a prop replaces
the same option of the plugin.

## Good to know

- The loader starts once per page and cannot be taken apart. The settings are read when the chat
  first appears. When the last `HamnivoChat` unmounts, the chat is closed and hidden, and it comes
  back when one mounts again.
- Nothing runs on the server. In Nuxt, register the plugin in a plugin that runs in the browser
  only, such as `plugins/hamnivo.client.ts`.
- With `:customer="{ key, getAssertion }"`, the chat identifies the signed-in customer, identifies
  the next one when `key` changes, and is signed out when the customer goes (`null`), also after a
  reload. Sign the assertion on your server with [`@hamnivo/server`](../server-sdk).
- `HamnivoChat` emits `ready` and `error`. Without an `@error` listener, errors go to the console.

## Develop

```bash
pnpm --filter @hamnivo/vue test       # builds, then runs the tests in a real Vue
pnpm --filter @hamnivo/vue typecheck
```

`src/embed.ts` has no framework in it and is an identical copy of the one in
[`@hamnivo/react`](../react): a test fails if they differ. A tag named `vue-v<version>` publishes
the package, see
[`.github/workflows/release-packages.yml`](../../.github/workflows/release-packages.yml).
