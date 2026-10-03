import type { App, Plugin } from 'vue';
import { HAMNIVO_OPTIONS, HamnivoChat } from './chat.js';
import type { HamnivoLoaderOptions } from './embed.js';

/** The settings every HamnivoChat starts from. A prop of the component replaces one of them. */
export type HamnivoPluginOptions = Partial<HamnivoLoaderOptions>;

/**
 * The plugin: it keeps your settings in one place and registers HamnivoChat everywhere, so that
 * `<HamnivoChat />` works without props.
 *
 * ```ts
 * app.use(createHamnivo({ widgetId: 'wid_…', chatUrl: 'https://chat.example.com' }));
 * ```
 */
export function createHamnivo(options: HamnivoPluginOptions = {}): Plugin {
  return {
    install(app: App) {
      app.provide(HAMNIVO_OPTIONS, options);
      app.component('HamnivoChat', HamnivoChat);
    },
  };
}
