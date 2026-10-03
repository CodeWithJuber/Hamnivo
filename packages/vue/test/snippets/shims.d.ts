// The snippets import App.vue as an app does. This tells TypeScript what a .vue file is.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<object, object, unknown>;
  export default component;
}
