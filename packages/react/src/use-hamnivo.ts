import { useMemo, useSyncExternalStore } from 'react';
import {
  getHamnivoState,
  type HamnivoControls,
  type HamnivoState,
  hamnivoControls,
  INITIAL_STATE,
  subscribeHamnivo,
} from './embed.js';

export type UseHamnivo = HamnivoState & HamnivoControls;

/**
 * The chat window as state, and the ways to control it: open, close, toggle, identify and reset.
 * The state is the same for every component, and renders again when it changes. On the server it
 * is the state of a page where the chat has not loaded. Before the chat is on the page the
 * controls that act on the window do nothing, and identify and reset wait for it, or fail if
 * nothing is loading it.
 */
export function useHamnivo(): UseHamnivo {
  const state = useSyncExternalStore(subscribeHamnivo, getHamnivoState, () => INITIAL_STATE);
  return useMemo(() => ({ ...state, ...hamnivoControls }), [state]);
}
