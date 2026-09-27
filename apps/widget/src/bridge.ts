import { BRIDGE_SOURCE, BRIDGE_VERSION, type FrameToHost, HostToFrame } from '@hamnivo/contracts';

type Payload = FrameToHost extends infer U
  ? U extends FrameToHost
    ? Omit<U, 'source' | 'v' | 'instanceId'>
    : never
  : never;

/**
 * postMessage bridge to the host-page loader (blueprint §10). Messages go only to the host origin
 * the loader declared, and incoming messages are accepted only from the parent window on that
 * origin and only in the documented shapes.
 */
export class HostBridge {
  constructor(
    private readonly hostOrigin: string | null,
    private readonly instanceId: string,
  ) {}

  post(message: Payload) {
    if (!this.hostOrigin || window.parent === window) return;
    window.parent.postMessage(
      { source: BRIDGE_SOURCE, v: BRIDGE_VERSION, instanceId: this.instanceId, ...message },
      this.hostOrigin,
    );
  }

  listen(handler: (message: HostToFrame) => void): () => void {
    const onMessage = (event: MessageEvent) => {
      if (!this.hostOrigin || event.origin !== this.hostOrigin || event.source !== window.parent)
        return;
      const parsed = HostToFrame.safeParse(event.data);
      if (parsed.success && parsed.data.instanceId === this.instanceId) handler(parsed.data);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }
}
