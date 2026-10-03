import {
  type ComputedRef,
  computed,
  getCurrentInstance,
  getCurrentScope,
  onBeforeUnmount,
  onMounted,
  onScopeDispose,
  shallowRef,
} from 'vue';
import {
  getHamnivoState,
  type HamnivoControls,
  hamnivoControls,
  subscribeHamnivo,
} from './embed.js';

export interface UseHamnivo extends HamnivoControls {
  /** The loader has started, so the controls work. */
  loaded: ComputedRef<boolean>;
  /** The chat window is open. Only the bubble and panel layouts open and close. */
  isOpen: ComputedRef<boolean>;
  /** Replies that wait while the chat is closed. */
  unread: ComputedRef<number>;
  /** This page told the chat who the visitor is, and the chat accepted it. */
  verified: ComputedRef<boolean>;
}

/**
 * The chat window as refs, and the ways to control it: open, close, toggle, identify and reset.
 * Every component sees the same state. On the server it is the state of a page where the chat has
 * not loaded, and nothing is subscribed. Before the chat is on the page the controls that act on
 * the window do nothing, and identify and reset wait for it, or fail if nothing is loading it.
 */
export function useHamnivo(): UseHamnivo {
  const state = shallowRef(getHamnivoState());
  const sync = () => {
    state.value = getHamnivoState();
  };
  const start = (): (() => void) => {
    const stop = subscribeHamnivo(sync);
    sync();
    return stop;
  };

  // In a component the subscription follows its mounting, which never happens on the server.
  if (getCurrentInstance()) {
    let stop: (() => void) | undefined;
    onMounted(() => {
      stop = start();
    });
    onBeforeUnmount(() => stop?.());
  } else if (typeof window !== 'undefined') {
    const stop = start();
    if (getCurrentScope()) onScopeDispose(stop);
  }

  return {
    loaded: computed(() => state.value.loaded),
    isOpen: computed(() => state.value.isOpen),
    unread: computed(() => state.value.unread),
    verified: computed(() => state.value.verified),
    ...hamnivoControls,
  };
}
