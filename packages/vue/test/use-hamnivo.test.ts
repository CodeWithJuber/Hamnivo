import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, effectScope, h, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { CHAT, fakeLoader, resetPage, startLoader, WIDGET } from './helpers.js';

type Lib = typeof import('../src/index.js');
let lib: Lib;
const mounted: { unmount(): void }[] = [];

beforeEach(async () => {
  vi.resetModules();
  lib = await import('../src/index.js');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  resetPage();
});

/** A component that shows the state, and keeps what useHamnivo gave it. */
function probe() {
  const seen: { chat?: ReturnType<Lib['useHamnivo']> } = {};
  const component = defineComponent({
    setup() {
      const chat = lib.useHamnivo();
      seen.chat = chat;
      return () =>
        h(
          'p',
          `${chat.loaded.value}/${chat.isOpen.value}/${chat.unread.value}/${chat.verified.value}`,
        );
    },
  });
  return { component, seen };
}

function show() {
  const { component, seen } = probe();
  const wrapper = mount(component);
  mounted.push(wrapper);
  return { wrapper, chat: seen.chat as ReturnType<Lib['useHamnivo']> };
}

async function load() {
  const loader = fakeLoader();
  const loading = lib.loadHamnivo({ widgetId: WIDGET, chatUrl: CHAT });
  startLoader(loader.api);
  await loading;
  await nextTick();
  return loader;
}

describe('useHamnivo', () => {
  it('is a page without the chat before the chat loads', () => {
    const { wrapper } = show();
    expect(wrapper.text()).toBe('false/false/0/false');
  });

  it('subscribes nothing on the server, and renders a page without the chat', async () => {
    const { api } = fakeLoader();
    const on = vi.fn(api.on);
    (window as unknown as { Hamnivo?: unknown }).Hamnivo = { ...api, on };
    const { component } = probe();
    const html = await renderToString(createSSRApp(component));
    expect(html).toBe('<p>false/false/0/false</p>');
    expect(on).not.toHaveBeenCalled();
  });

  it('follows the chat: loaded, open, unread and verified', async () => {
    const { wrapper, chat } = show();
    const { api, emit } = await load();
    expect(wrapper.text()).toBe('true/false/0/false');

    chat.open();
    await nextTick();
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(chat.isOpen.value).toBe(true);
    chat.close();
    await nextTick();
    expect(chat.isOpen.value).toBe(false);

    emit('unread', { count: 3 });
    emit('identity.changed', { verified: true });
    await nextTick();
    expect(wrapper.text()).toBe('true/false/3/true');
  });

  it('gives every component the same state', async () => {
    const one = show();
    const two = show();
    const { emit } = await load();
    emit('unread', { count: 2 });
    await nextTick();
    expect(one.chat.unread.value).toBe(2);
    expect(two.chat.unread.value).toBe(2);
  });

  it('identifies and resets through the chat, and says so when the chat is not on the page', async () => {
    const { chat } = show();
    await expect(chat.identify('a')).rejects.toThrow('not on this page yet');
    const { api } = await load();
    await chat.identify('assertion-1');
    await chat.reset();
    await flushPromises();
    expect(api.identify).toHaveBeenCalledWith('assertion-1');
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(chat.verified.value).toBe(false);
  });

  it('stops following the chat when its component is gone', async () => {
    const { wrapper, chat } = show();
    const { emit } = await load();
    emit('unread', { count: 1 });
    await nextTick();
    wrapper.unmount();
    emit('unread', { count: 9 });
    await nextTick();
    expect(chat.unread.value).toBe(1);
  });

  it('picks up a chat that the install code on the page started', async () => {
    const { api, emit } = fakeLoader();
    (window as unknown as { Hamnivo?: unknown }).Hamnivo = api;
    const { wrapper, chat } = show();
    await nextTick();
    expect(chat.loaded.value).toBe(true);
    emit('unread', { count: 4 });
    await nextTick();
    expect(wrapper.text()).toBe('true/false/4/false');
  });

  it('works outside a component, in a store for example, until its scope stops', async () => {
    const scope = effectScope();
    const chat = scope.run(() => lib.useHamnivo()) as ReturnType<Lib['useHamnivo']>;
    const { emit } = await load();
    expect(chat.loaded.value).toBe(true);
    emit('unread', { count: 5 });
    expect(chat.unread.value).toBe(5);
    scope.stop();
    emit('unread', { count: 6 });
    expect(chat.unread.value).toBe(5);
  });
});
