import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import type { AuthorityMessage } from '@hamnivo/domain';
import { eq } from 'drizzle-orm';
import { type EventSourceMessage, EventSourceParserStream } from 'eventsource-parser/stream';
import { expect } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { type Client, CONSOLE_ORIGIN, signUp } from './harness.js';
import { type connectedTenant, type Slice, Visitor } from './slice-harness.js';

export type Shop = Awaited<ReturnType<typeof connectedTenant>>;

/** Invites a person with a role at a scope and returns them signed in, in the shop's tenant. */
export async function join(
  slice: Slice,
  shop: Shop,
  name: string,
  role: string,
  scope: object = { type: 'tenant' },
): Promise<{ client: Client; staffId: string }> {
  const roles = await shop.owner.get('/v1/admin/roles');
  const roleId = roles.body.items.find((r: { key: string }) => r.key === role)?.id;
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${randomUUID().slice(0, 6)}@example.com`;
  const invited = await shop.owner.post('/v1/admin/invitations', { email, roleId, scope });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const client = await signUp(slice.gw, name, email);
  const accepted = await client.post('/v1/invitations/accept', { token: invited.body.token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  client.tenant = shop.owner.tenant;
  return { client, staffId: accepted.body.staffMemberId as string };
}

/** A customer starts a conversation in the brand's widget; returns the visitor and its id. */
export async function customerStarts(slice: Slice, shop: Shop, text: string) {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    firstMessage: text,
    clientMessageId: randomUUID(),
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { visitor, conversationId: started.body.id as string };
}

/** The control row and Chatwoot's view of a conversation (staff view, as the integration user). */
export async function authority(slice: Slice, shop: Shop, conversationId: string) {
  const tenantId = fromPublicId('tenant', shop.tenantId);
  const [control] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, fromPublicId('conversation', conversationId))),
  );
  if (!control) throw new Error('control missing');
  const runtime = await slice.worker
    .get(AuthorityRegistry)
    .get(tenantId, fromPublicId('connection', shop.connection.id));
  const ref = String(control.externalConversationId);
  const messages: AuthorityMessage[] = [];
  let before: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await runtime.authority.listMessages(
      ref,
      before ? { view: 'staff', before } : { view: 'staff' },
    );
    messages.unshift(...page);
    if (page.length < 20 || !page[0]) break;
    before = page[0].ref;
  }
  return { control, runtime, ref, state: await runtime.authority.getState(ref), messages };
}

/** Audit actions recorded for one conversation, oldest first. */
export async function audits(slice: Slice, shop: Shop, conversationId: string) {
  const tenantId = fromPublicId('tenant', shop.tenantId);
  const rows = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select({ action: schema.auditEvents.action, data: schema.auditEvents.data })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, conversationId))
      .orderBy(schema.auditEvents.seq),
  );
  return rows;
}

/** The staff inbox stream over real HTTP, as Studio reads it. */
export class StaffStream {
  readonly messages: EventSourceMessage[] = [];
  ended = false;
  private readonly controller = new AbortController();
  readonly ready: Promise<Response>;

  constructor(baseUrl: string, client: Client) {
    this.ready = fetch(`${baseUrl}/v1/inbox/events`, {
      headers: {
        cookie: client.cookieHeader(),
        origin: CONSOLE_ORIGIN,
        'x-hamnivo-tenant': client.tenant ?? '',
      },
      signal: this.controller.signal,
    });
    void this.ready
      .then(async (response) => {
        if (!response.body) return;
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream())
          .getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.messages.push(value);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.ended = true;
      });
  }

  events(type: string): Array<Record<string, any>> {
    return this.messages.filter((m) => m.event === type).map((m) => JSON.parse(m.data));
  }

  changed(): string[] {
    return this.events('inbox.changed').flatMap((e) => e.conversationIds as string[]);
  }

  async until(predicate: (s: StaffStream) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      if (Date.now() > deadline) {
        throw new Error(
          `stream condition not met; got ${JSON.stringify(this.messages.map((m) => [m.event, m.data]))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  close() {
    this.controller.abort();
  }
}
