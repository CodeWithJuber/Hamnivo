import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import {
  CHAT,
  failLoader,
  fakeLoader,
  injectedScript,
  resetPage,
  startLoader,
  WIDGET,
} from './helpers.js';

/** The component and the plugin, in a real Vue, with a stand-in for the loader. */
type Lib = typeof import('../src/index.js');
let lib: Lib;
const FLAG = `hamnivo:embed:verified:${WIDGET}`;
const hidden = () => document.getElementById('hamnivo-embed-hidden');
const mounted: { unmount(): void }[] = [];

beforeEach(async () => {
  vi.resetModules();
  lib = await import('../src/index.js');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPage();
});

function mountChat(
  props: Record<string, unknown> = {},
  listeners: Record<string, (value: never) => void> = {},
) {
  const wrapper = mount(lib.HamnivoChat, {
    props: { widgetId: WIDGET, chatUrl: CHAT, ...props, ...listeners },
  });
  mounted.push(wrapper);
  return wrapper;
}

const customer = (key: string, getAssertion = vi.fn(async () => `assertion-for-${key}`)) => ({
  key,
  getAssertion,
});

describe('HamnivoChat', () => {
  it('renders nothing, and puts the loader on the page with its settings', () => {
    const wrapper = mountChat({
      apiUrl: 'https://api.example.com',
      locale: 'ar',
      mode: 'panel',
      color: '#123456',
    });
    expect(wrapper.html()).toBe('');
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

  it('adds the loader once, however many components ask for it', () => {
    mountChat();
    mountChat({ widgetId: 'wid_zzzzzzzzzzzzzzzzzzzzzzzzzz' });
    expect(document.querySelectorAll('script')).toHaveLength(1);
    expect((injectedScript() as HTMLScriptElement).dataset.widgetId).toBe(WIDGET);
  });

  it('emits ready with the chat once the loader has started', async () => {
    const onReady = vi.fn();
    const wrapper = mountChat({}, { onReady });
    const { api } = fakeLoader();
    startLoader(api);
    await flushPromises();
    expect(onReady).toHaveBeenCalledWith(api);
    expect(wrapper.emitted('ready')).toHaveLength(1);
  });

  it('emits error when the loader cannot be loaded', async () => {
    const onError = vi.fn();
    mountChat({}, { onError });
    failLoader();
    await flushPromises();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('could not be loaded from') }),
    );
  });

  it('says what is wrong on the console when nothing listens for the error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mountChat({ chatUrl: 'chat.example.com' });
    await flushPromises();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('chatUrl must be a web address');
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  it('hides the chat when it unmounts and shows it when it mounts again', async () => {
    const { api } = fakeLoader();
    const first = mountChat();
    startLoader(api);
    await flushPromises();
    expect(hidden()).toBeNull();
    first.unmount();
    expect(hidden()).not.toBeNull();
    expect(api.close).toHaveBeenCalled();
    mountChat();
    expect(hidden()).toBeNull();
  });

  it('keeps the chat while any HamnivoChat is on the page', () => {
    const one = mountChat();
    const two = mountChat();
    one.unmount();
    expect(hidden()).toBeNull();
    two.unmount();
    expect(hidden()).not.toBeNull();
  });
});

describe('createHamnivo', () => {
  const install = () =>
    lib.createHamnivo({
      widgetId: WIDGET,
      chatUrl: CHAT,
      apiUrl: 'https://api.example.com',
      locale: 'hi',
    });

  // A component written the way an app writes it: a template that uses the plugin's component.
  function mountTemplate(template: string, plugin = install(), saw = vi.fn()) {
    const wrapper = mount(defineComponent({ template, methods: { saw } }), {
      global: { plugins: [plugin] },
    });
    mounted.push(wrapper);
    return wrapper;
  }

  it('registers HamnivoChat everywhere, so that it needs no props', () => {
    const wrapper = mountTemplate('<div><HamnivoChat /></div>');
    expect(wrapper.findComponent({ name: 'HamnivoChat' }).exists()).toBe(true);
    const script = injectedScript() as HTMLScriptElement;
    expect(script.src).toBe('https://chat.example.com/loader.js');
    expect({ ...script.dataset }).toEqual({
      widgetId: WIDGET,
      api: 'https://api.example.com',
      locale: 'hi',
    });
  });

  it('lets a prop replace one of the options, written the way a template writes it', () => {
    mountTemplate('<HamnivoChat locale="ur" chat-url="https://other.example.com/" />');
    const script = injectedScript() as HTMLScriptElement;
    expect(script.src).toBe('https://other.example.com/loader.js');
    expect(script.dataset.locale).toBe('ur');
    expect(script.dataset.widgetId).toBe(WIDGET);
  });

  it('needs nothing from the plugin when the component is given everything', () => {
    const wrapper = mount(
      defineComponent({
        components: { HamnivoChat: lib.HamnivoChat },
        template: `<HamnivoChat widget-id="${WIDGET}" chat-url="${CHAT}" />`,
      }),
    );
    mounted.push(wrapper);
    expect((injectedScript() as HTMLScriptElement).dataset.widgetId).toBe(WIDGET);
  });

  it('reports a widget ID or a chat address that is missing everywhere', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mountTemplate('<HamnivoChat />', lib.createHamnivo({ chatUrl: CHAT }));
    await flushPromises();
    expect(error.mock.calls[0]?.[0]).toContain('widgetId is required');
  });

  it('passes the events up, as @ready and @error', async () => {
    const saw = vi.fn();
    mountTemplate(
      '<HamnivoChat @ready="saw(\'ready\')" @error="saw(\'error\')" />',
      install(),
      saw,
    );
    const { api } = fakeLoader();
    startLoader(api);
    await flushPromises();
    expect(saw).toHaveBeenCalledWith('ready');
    expect(saw).not.toHaveBeenCalledWith('error');
  });

  it('passes the error up as @error, when the loader cannot be loaded', async () => {
    const saw = vi.fn();
    mountTemplate('<HamnivoChat @error="saw(\'error\')" />', install(), saw);
    failLoader();
    await flushPromises();
    expect(saw).toHaveBeenCalledWith('error');
  });
});

describe('HamnivoChat, with a customer', () => {
  async function started(props: Record<string, unknown> = {}, listeners = {}) {
    const loader = fakeLoader();
    const wrapper = mountChat(props, listeners);
    startLoader(loader.api);
    await flushPromises();
    return { ...loader, wrapper };
  }

  it('identifies the signed-in customer with a fresh assertion once the loader has started', async () => {
    const who = customer('cus_1');
    const { api } = await started({ customer: who });
    expect(api.identify).toHaveBeenCalledWith('assertion-for-cus_1');
    expect(who.getAssertion).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(FLAG)).toBe('1');
  });

  it('identifies the next customer when the key changes, and not when only the function does', async () => {
    const { api, wrapper } = await started({ customer: customer('cus_1') });
    expect(api.identify).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ customer: customer('cus_1') });
    await flushPromises();
    expect(api.identify).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ customer: customer('cus_2') });
    await flushPromises();
    expect(api.identify).toHaveBeenCalledTimes(2);
    expect(api.identify).toHaveBeenLastCalledWith('assertion-for-cus_2');
  });

  it('calls the getAssertion of the latest props', async () => {
    const stale = customer('cus_1');
    const fresh = customer('cus_1');
    const loader = fakeLoader();
    const wrapper = mountChat({ customer: stale });
    await wrapper.setProps({ customer: fresh });
    startLoader(loader.api);
    await flushPromises();
    expect(stale.getAssertion).not.toHaveBeenCalled();
    expect(fresh.getAssertion).toHaveBeenCalledTimes(1);
  });

  it('signs the chat out when the customer signs out', async () => {
    const { api, wrapper } = await started({ customer: customer('cus_1') });
    await wrapper.setProps({ customer: null });
    await flushPromises();
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('signs out a browser that was verified before this page, when nobody is signed in', async () => {
    window.localStorage.setItem(FLAG, '1');
    const { api } = await started();
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(FLAG)).toBeNull();
  });

  it('leaves an anonymous visitor alone', async () => {
    const { api } = await started();
    expect(api.identify).not.toHaveBeenCalled();
    expect(api.reset).not.toHaveBeenCalled();
  });

  it('emits error for a failing getAssertion, and identifies nobody', async () => {
    const onError = vi.fn();
    const broken = customer(
      'cus_1',
      vi.fn(async () => {
        throw new Error('The identity route refused.');
      }),
    );
    const { api } = await started({ customer: broken }, { onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'The identity route refused.' }),
    );
    expect(api.identify).not.toHaveBeenCalled();
  });

  it('works through a render function too', async () => {
    const loader = fakeLoader();
    const who = customer('cus_1');
    const wrapper = mount(
      defineComponent({
        render: () => h(lib.HamnivoChat, { widgetId: WIDGET, chatUrl: CHAT, customer: who }),
      }),
    );
    mounted.push(wrapper);
    startLoader(loader.api);
    await flushPromises();
    expect(loader.api.identify).toHaveBeenCalledWith('assertion-for-cus_1');
  });
});
