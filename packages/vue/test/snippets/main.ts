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
