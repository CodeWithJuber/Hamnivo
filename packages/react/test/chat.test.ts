import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT,
  failLoader,
  fakeLoader,
  injectedScript,
  resetPage,
  startLoader,
  WIDGET,
} from './helpers.js';

/** The component, in a real React, with a stand-in for the loader. */
type Lib = typeof import('../src/index.js');
let lib: Lib;
const FLAG = `hamnivo:embed:verified:${WIDGET}`;
const hidden = () => document.getElementById('hamnivo-embed-hidden');

beforeEach(async () => {
  vi.resetModules();
  lib = await import('../src/index.js');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPage();
});

const chat = (props: Partial<import('../src/index.js').HamnivoChatProps> = {}) =>
  createElement(lib.HamnivoChat, { widgetId: WIDGET, chatUrl: CHAT, ...props });

const customer = (key: string, getAssertion = vi.fn(async () => `assertion-for-${key}`)) => ({
  key,
  getAssertion,
});

describe('HamnivoChat', () => {
  it('renders nothing, and puts the loader on the page with its settings', () => {
    const { container } = render(
      chat({ apiUrl: 'https://api.example.com', locale: 'ar', mode: 'panel', color: '#123456' }),
    );
    expect(container.innerHTML).toBe('');
    const script = injectedScript() as HTMLScriptElement;
    expect(script.src).toBe('https://chat.example.com/loader.js');
    expect({ ...script.dataset }).toEqual({
      widgetId: WIDGET,
      api: 'https://api.example.com',
      locale: 'ar',
      mode: 'panel',
      color: '#123456',
    });
  });

  it('adds the loader once, also when React runs the effects twice and when it renders again', () => {
    const { rerender } = render(createElement(StrictMode, null, chat()));
    rerender(createElement(StrictMode, null, chat({ widgetId: 'wid_zzzzzzzzzzzzzzzzzzzzzzzzzz' })));
    expect(document.querySelectorAll('script')).toHaveLength(1);
    expect((injectedScript() as HTMLScriptElement).dataset.widgetId).toBe(WIDGET);
  });

  it('calls onReady with the chat once the loader has started', async () => {
    const onReady = vi.fn();
    render(chat({ onReady }));
    const { api } = fakeLoader();
    startLoader(api);
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(api));
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('calls onError when the loader cannot be loaded', async () => {
    const onError = vi.fn();
    render(chat({ onError }));
    failLoader();
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('could not be loaded from') }),
    );
  });

  it('says what is wrong on the console when nothing asked for the error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(chat({ chatUrl: 'chat.example.com' }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    await act(async () => undefined);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('chatUrl must be a web address');
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  it('uses the callbacks of the latest render', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(chat({ onReady: first }));
    rerender(chat({ onReady: second }));
    const { api } = fakeLoader();
    startLoader(api);
    await waitFor(() => expect(second).toHaveBeenCalledWith(api));
    expect(first).not.toHaveBeenCalled();
  });

  it('hides the chat when it unmounts and shows it when it mounts again', async () => {
    const { api } = fakeLoader();
    const view = render(chat());
    startLoader(api);
    await waitFor(() => expect(api.reset).not.toHaveBeenCalled());
    expect(hidden()).toBeNull();
    view.unmount();
    expect(hidden()).not.toBeNull();
    expect(api.close).toHaveBeenCalled();
    render(chat());
    expect(hidden()).toBeNull();
  });

  it('keeps the chat while any HamnivoChat is on the page', () => {
    const one = render(chat());
    const two = render(chat());
    one.unmount();
    expect(hidden()).toBeNull();
    two.unmount();
    expect(hidden()).not.toBeNull();
  });
});

describe('HamnivoChat, with a customer', () => {
  async function started(props: Partial<import('../src/index.js').HamnivoChatProps> = {}) {
    const loader = fakeLoader();
    const view = render(chat(props));
    startLoader(loader.api);
    return { ...loader, view };
  }

  it('identifies the signed-in customer with a fresh assertion once the loader has started', async () => {
    const who = customer('cus_1');
    const { api } = await started({ customer: who });
    await waitFor(() => expect(api.identify).toHaveBeenCalledWith('assertion-for-cus_1'));
    expect(who.getAssertion).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(FLAG)).toBe('1');
  });

  it('asks for the assertion once, also when React runs the effects twice', async () => {
    const who = customer('cus_1');
    const loader = fakeLoader();
    render(createElement(StrictMode, null, chat({ customer: who })));
    startLoader(loader.api);
    await waitFor(() => expect(loader.api.identify).toHaveBeenCalled());
    // The second effect is a newer sync, so the first never asks.
    expect(who.getAssertion).toHaveBeenCalledTimes(1);
    expect(loader.api.identify).toHaveBeenCalledTimes(1);
  });

  it('identifies the next customer when the key changes, and does not when only the function does', async () => {
    const { api, view } = await started({ customer: customer('cus_1') });
    await waitFor(() => expect(api.identify).toHaveBeenCalledTimes(1));
    view.rerender(chat({ customer: customer('cus_1') }));
    await act(async () => undefined);
    expect(api.identify).toHaveBeenCalledTimes(1);
    view.rerender(chat({ customer: customer('cus_2') }));
    await waitFor(() => expect(api.identify).toHaveBeenCalledTimes(2));
    expect(api.identify).toHaveBeenLastCalledWith('assertion-for-cus_2');
  });

  it('calls the getAssertion of the latest render', async () => {
    const stale = customer('cus_1');
    const fresh = customer('cus_1');
    const loader = fakeLoader();
    const view = render(chat({ customer: stale }));
    view.rerender(chat({ customer: fresh }));
    startLoader(loader.api);
    await waitFor(() => expect(loader.api.identify).toHaveBeenCalled());
    expect(stale.getAssertion).not.toHaveBeenCalled();
    expect(fresh.getAssertion).toHaveBeenCalledTimes(1);
  });

  it('signs the chat out when the customer signs out', async () => {
    const { api, view } = await started({ customer: customer('cus_1') });
    await waitFor(() => expect(api.identify).toHaveBeenCalledTimes(1));
    view.rerender(chat({ customer: null }));
    await waitFor(() => expect(api.reset).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('signs out a browser that was verified before this page, when nobody is signed in', async () => {
    window.localStorage.setItem(FLAG, '1');
    const { api } = await started();
    await waitFor(() => expect(api.reset).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('leaves an anonymous visitor alone', async () => {
    const onReady = vi.fn();
    const { api } = await started({ onReady });
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(api.identify).not.toHaveBeenCalled();
    expect(api.reset).not.toHaveBeenCalled();
  });

  it('reports a failing getAssertion with onError, and identifies nobody', async () => {
    const onError = vi.fn();
    const broken = customer(
      'cus_1',
      vi.fn(async () => {
        throw new Error('The identity route refused.');
      }),
    );
    const { api } = await started({ customer: broken, onError });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'The identity route refused.' }),
    );
    expect(api.identify).not.toHaveBeenCalled();
  });

  it('tells useHamnivo that the visitor is verified', async () => {
    const { api, emit } = await started({ customer: customer('cus_1') });
    await waitFor(() => expect(api.identify).toHaveBeenCalled());
    expect(emit).toBeTypeOf('function');
    const state = await import('../src/embed.js');
    expect(state.getHamnivoState().verified).toBe(true);
  });
});
