import {
  defineComponent,
  getCurrentInstance,
  type InjectionKey,
  inject,
  onBeforeUnmount,
  onMounted,
  type PropType,
  watch,
} from 'vue';
import {
  type HamnivoApi,
  type HamnivoCustomer,
  type HamnivoLoaderOptions,
  type HamnivoMode,
  loadHamnivo,
  mountHamnivo,
  syncHamnivoCustomer,
} from './embed.js';

/** What createHamnivo gives every HamnivoChat, so that the component needs no props. */
export const HAMNIVO_OPTIONS: InjectionKey<Partial<HamnivoLoaderOptions>> = Symbol('hamnivo');

/**
 * Puts Hamnivo Chat on the page and renders nothing itself. Render it once, in your root component.
 * The settings come from its props, and from the options given to createHamnivo for any it lacks.
 * The loader starts once per page, so the settings are read when the chat first appears and later
 * changes to them are ignored. When the last HamnivoChat unmounts the chat is hidden, and it comes
 * back when one mounts again.
 *
 * With a `customer`, the chat asks its `getAssertion` for a fresh assertion and identifies them, so
 * they see their own conversations on any device. When the `key` changes it identifies the new
 * customer, and when the customer goes (null) the chat is signed out. Keep `key` stable: it is how
 * a change is noticed.
 *
 * Events: `ready` with the chat once the loader has started, and `error` with an Error when it
 * cannot start or when telling the chat who is signed in fails.
 */
export const HamnivoChat = defineComponent({
  name: 'HamnivoChat',
  props: {
    widgetId: { type: String, default: undefined },
    chatUrl: { type: String, default: undefined },
    apiUrl: { type: String, default: undefined },
    locale: { type: String, default: undefined },
    mode: { type: String as PropType<HamnivoMode>, default: undefined },
    position: { type: String as PropType<'bottom-right' | 'bottom-left'>, default: undefined },
    color: { type: String, default: undefined },
    container: { type: String, default: undefined },
    height: { type: String, default: undefined },
    labels: {
      type: Object as PropType<{ open?: string; close?: string; title?: string }>,
      default: undefined,
    },
    theme: { type: String as PropType<'light' | 'dark' | 'auto'>, default: undefined },
    offset: { type: Object as PropType<{ x?: number; y?: number }>, default: undefined },
    launcher: {
      type: Object as PropType<{
        size?: 'small' | 'medium' | 'large';
        icon?: 'chat' | 'message' | 'help' | 'sparkle';
      }>,
      default: undefined,
    },
    zIndex: { type: Number, default: undefined },
    hideOn: { type: Array as PropType<string[]>, default: undefined },
    // Left out is "not said", not false: the brand's own choice then applies.
    hideOnMobile: { type: Boolean, default: undefined },
    nonce: { type: String, default: undefined },
    customer: { type: Object as PropType<HamnivoCustomer | null>, default: null },
  },
  emits: {
    ready: (_api: HamnivoApi) => true,
    error: (_error: Error) => true,
  },
  setup(props, { emit }) {
    const defaults = inject(HAMNIVO_OPTIONS, {});
    // The props that were given win over the options of the plugin. A prop left out is undefined.
    const options = (): HamnivoLoaderOptions => {
      const given = Object.fromEntries(
        Object.entries(props).filter(([name, value]) => name !== 'customer' && value !== undefined),
      );
      return { ...defaults, ...given } as HamnivoLoaderOptions;
    };

    // An error goes to the @error listener, or to the console when nothing listens, so that it is
    // never lost.
    const instance = getCurrentInstance();
    const report = (error: Error) => {
      if (instance?.vnode.props?.onError) emit('error', error);
      else console.error(error.message);
    };
    let unmount: (() => void) | undefined;
    let cancelled = false;
    let mounted = false;

    const sync = () => {
      syncHamnivoCustomer(options(), () => props.customer ?? null).catch((error: Error) => {
        if (!cancelled) report(error);
      });
    };

    onMounted(() => {
      mounted = true;
      unmount = mountHamnivo();
      loadHamnivo(options()).then(
        (api) => {
          if (!cancelled) emit('ready', api);
        },
        (error: Error) => {
          if (!cancelled) report(error);
        },
      );
      sync();
    });

    // A change of customer is a change of key. The latest getAssertion is the one that is called.
    watch(
      () => props.customer?.key ?? null,
      () => {
        if (mounted) sync();
      },
    );

    onBeforeUnmount(() => {
      cancelled = true;
      unmount?.();
    });

    return () => null;
  },
});
