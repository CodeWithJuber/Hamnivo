import { z } from 'zod';
import { PageContext } from './conversations.js';

/**
 * postMessage protocol between the host-page loader and the widget iframe (blueprint §10).
 * Both sides check `event.origin`, `event.source` and this schema; there is no generic method call.
 * Messages never carry secrets other than a tenant-minted identity assertion (host → frame).
 */
export const BRIDGE_SOURCE = 'hamnivo';
export const BRIDGE_VERSION = 1;

const base = {
  source: z.literal(BRIDGE_SOURCE),
  v: z.literal(BRIDGE_VERSION),
  instanceId: z.string().max(64),
};

/** Host → frame. */
export const HostToFrame = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('open') }),
  z.object({ ...base, type: z.literal('close') }),
  z.object({
    ...base,
    type: z.literal('identify'),
    assertion: z.string().min(20).max(4096),
    requestId: z.string().max(64),
  }),
  z.object({ ...base, type: z.literal('reset'), requestId: z.string().max(64) }),
  z.object({ ...base, type: z.literal('set-context'), context: PageContext }),
  z.object({
    ...base,
    type: z.literal('send-message'),
    text: z.string().min(1).max(10_000),
    requestId: z.string().max(64),
  }),
  z.object({ ...base, type: z.literal('set-locale'), locale: z.string().max(35) }),
]);
export type HostToFrame = z.infer<typeof HostToFrame>;

/** Public events a host page can subscribe to via `Hamnivo.on(...)`. Payloads are scoped, not account data. */
export const PublicWidgetEvent = z.enum([
  'ready',
  'open',
  'close',
  'unread',
  'conversation.started',
  'conversation.resolved',
  'handoff.requested',
  'identity.changed',
  /** The customer must sign in on the website to approve an AI action (payload: actionId). */
  'identity.required',
  'error',
]);
export type PublicWidgetEvent = z.infer<typeof PublicWidgetEvent>;

/** Frame → host. */
export const FrameToHost = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('ready'), widgetVersion: z.string().max(40) }),
  z.object({
    ...base,
    type: z.literal('layout'),
    open: z.boolean(),
    width: z.int().min(0).max(4000),
    height: z.int().min(0).max(4000),
  }),
  z.object({
    ...base,
    type: z.literal('event'),
    event: PublicWidgetEvent,
    payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
  z.object({
    ...base,
    type: z.literal('result'),
    requestId: z.string().max(64),
    ok: z.boolean(),
    error: z.string().max(80).optional(),
  }),
]);
export type FrameToHost = z.infer<typeof FrameToHost>;
