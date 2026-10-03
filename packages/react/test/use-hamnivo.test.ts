import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT, fakeLoader, resetPage, startLoader, WIDGET } from './helpers.js';

type Lib = typeof import('../src/index.js');
let lib: Lib;

beforeEach(async () => {
  vi.resetModules();
  lib = await import('../src/index.js');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetPage();
});

async function load() {
  const loader = fakeLoader();
  await act(async () => {
    const loading = lib.loadHamnivo({ widgetId: WIDGET, chatUrl: CHAT });
    startLoader(loader.api);
    await loading;
  });
  return loader;
}

describe('useHamnivo', () => {
  it('is a page without the chat on the server, and before the chat loads', () => {
    function Probe() {
      const chat = lib.useHamnivo();
      return createElement(
        'p',
        null,
        `${chat.loaded}/${chat.isOpen}/${chat.unread}/${chat.verified}`,
      );
    }
    expect(renderToString(createElement(Probe))).toContain('false/false/0/false');
    const { result } = renderHook(() => lib.useHamnivo());
    expect(result.current).toMatchObject({
      loaded: false,
      isOpen: false,
      unread: 0,
      verified: false,
    });
  });

  it('follows the chat: loaded, open, unread and verified', async () => {
    const { result } = renderHook(() => lib.useHamnivo());
    const { api, emit } = await load();
    expect(result.current.loaded).toBe(true);

    act(() => result.current.open());
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);

    act(() => emit('unread', { count: 3 }));
    expect(result.current.unread).toBe(3);
    act(() => emit('identity.changed', { verified: true }));
    expect(result.current.verified).toBe(true);
  });

  it('gives every component the same state', async () => {
    const one = renderHook(() => lib.useHamnivo());
    const two = renderHook(() => lib.useHamnivo());
    const { emit } = await load();
    act(() => emit('unread', { count: 1 }));
    expect(one.result.current.unread).toBe(1);
    expect(two.result.current.unread).toBe(1);
  });

  it('keeps the same controls from one render to the next, so they are safe in dependency lists', async () => {
    const { result, rerender } = renderHook(() => lib.useHamnivo());
    const before = result.current;
    await load();
    rerender();
    for (const name of ['open', 'close', 'toggle', 'identify', 'reset'] as const) {
      expect(result.current[name], name).toBe(before[name]);
    }
  });

  it('identifies and resets through the chat, and says so when the chat is not on the page', async () => {
    const { result } = renderHook(() => lib.useHamnivo());
    await expect(result.current.identify('a')).rejects.toThrow('not on this page yet');
    const { api } = await load();
    await act(async () => {
      await result.current.identify('assertion-1');
      await result.current.reset();
    });
    expect(api.identify).toHaveBeenCalledWith('assertion-1');
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(result.current.verified).toBe(false);
  });

  it('picks up a chat that the install code on the page started', () => {
    const { api, emit } = fakeLoader();
    (window as unknown as { Hamnivo?: unknown }).Hamnivo = api;
    const { result } = renderHook(() => lib.useHamnivo());
    expect(result.current.loaded).toBe(true);
    act(() => emit('unread', { count: 4 }));
    expect(result.current.unread).toBe(4);
  });
});
