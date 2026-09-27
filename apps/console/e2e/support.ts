/**
 * Shared helpers for the Studio end-to-end tests: the running stack, staff set up through the
 * gateway API, direct database changes for session scenarios, TOTP codes, the widget API and
 * accessibility audits.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { createDb } from '@hamnivo/db';
import { type BrowserContext, expect, type Page } from '@playwright/test';

export interface Stack {
  studioUrl: string;
  apiBase: string;
  widgetOrigin: string;
  databaseUrl: string;
}

export const stack = (): Stack =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8'));

export const PASSWORD = 'correct horse battery staple';
/** The website every seeded brand allows, and where widget conversations say they come from. */
export const SHOP = 'https://shop.example';

export const uniqueEmail = (prefix: string) =>
  `${prefix}+${randomBytes(4).toString('hex')}@example.com`;

interface Brand {
  id: string;
  name: string;
  widgetId: string;
}
interface Agent {
  id: string;
  brandId: string;
  name: string;
}

/** A staff member signed in through the gateway API, as Studio's own origin would be. */
export class Staff {
  tenantId = '';

  private constructor(
    readonly email: string,
    readonly cookie: string,
  ) {}

  static async signUp(name = 'Sara Staff', prefix = 'staff'): Promise<Staff> {
    const email = uniqueEmail(prefix);
    const response = await fetch(`${stack().apiBase}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: stack().studioUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ name, email, password: PASSWORD }),
    });
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(response.ok && cookie.length > 0, `sign-up returned ${response.status}`).toBe(true);
    return new Staff(email, cookie);
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${stack().apiBase}${path}`, {
      method,
      headers: {
        origin: stack().studioUrl,
        cookie: this.cookie,
        'content-type': 'application/json',
        ...(this.tenantId ? { 'x-hamnivo-tenant': this.tenantId } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Signs the browser in as this person, with this workspace chosen. */
  async signIn(context: BrowserContext) {
    const url = stack().studioUrl;
    await context.addCookies(
      this.cookie.split('; ').map((pair) => {
        const at = pair.indexOf('=');
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url };
      }),
    );
    await context.addInitScript((tenantId) => {
      try {
        window.localStorage.setItem('hamnivo.studio.tenant', tenantId);
      } catch {
        // Private mode: Studio then asks which workspace to open.
      }
    }, this.tenantId);
  }
}

export interface Workspace {
  staff: Staff;
  brand: Brand;
  /** The brand's default assistant, created as a draft when Chatwoot is connected. */
  agent?: Agent;
}

/** Owner → workspace → brand (allowed on SHOP), optionally connected and with the agent live. */
export async function seedWorkspace(
  options: { brand?: string; connect?: boolean; publish?: boolean } = {},
): Promise<Workspace> {
  const staff = await Staff.signUp();
  const slug = `e2e-${randomBytes(4).toString('hex')}`;
  const membership = await staff.call<{ tenant: { id: string } }>('POST', '/v1/tenants', {
    name: `Workspace ${slug}`,
    slug,
  });
  staff.tenantId = membership.tenant.id;
  const workspaces = await staff.call<{ items: Array<{ id: string }> }>(
    'GET',
    '/v1/admin/workspaces',
  );
  const brand = await staff.call<Brand>('POST', '/v1/admin/brands', {
    workspaceId: workspaces.items[0]?.id,
    name: options.brand ?? 'Noor Books',
    allowedOrigins: [SHOP],
  });
  if (!options.connect && !options.publish) return { staff, brand };
  await staff.call('POST', '/v1/admin/authority/connections', { brandId: brand.id });
  const agents = await staff.call<{ items: Agent[] }>('GET', '/v1/admin/agents');
  const agent = agents.items.find((a) => a.brandId === brand.id);
  if (!agent) throw new Error('connecting Chatwoot created no agent');
  if (options.publish) await staff.call('POST', `/v1/admin/agents/${agent.id}/publish`, {});
  return { staff, brand, agent };
}

/** Adds a public source with one Markdown document and waits until answers can use it. */
export async function seedKnowledge(workspace: Workspace, markdown: string) {
  const { staff, brand } = workspace;
  const source = await staff.call<{ id: string }>('POST', '/v1/admin/knowledge/sources', {
    brandId: brand.id,
    name: 'Help centre',
    visibility: 'public',
    reviewEveryDays: 90,
  });
  const document = await staff.call<{ id: string }>(
    'POST',
    `/v1/admin/knowledge/sources/${source.id}/documents`,
    { title: 'Shipping and returns', content: { mediaType: 'text/markdown', text: markdown } },
  );
  await expect
    .poll(
      async () => {
        const documents = await staff.call<{
          items: Array<{ current: { state: string } | null }>;
        }>('GET', `/v1/admin/knowledge/sources/${source.id}/documents`);
        return documents.items[0]?.current?.state ?? 'none';
      },
      { timeout: 30_000 },
    )
    .toBe('ready');
  return { sourceId: source.id, documentId: document.id };
}

/** A customer starts a conversation through the widget API, as the chat window would. */
export async function customerAsks(widgetId: string, text: string) {
  const { apiBase, widgetOrigin } = stack();
  const headers = { origin: widgetOrigin, 'content-type': 'application/json' };
  const session = await fetch(`${apiBase}/v1/widget/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ widgetId, hostOrigin: SHOP, locale: 'en' }),
  });
  expect(session.status, 'widget session').toBe(201);
  const { accessToken } = (await session.json()) as { accessToken: string };
  const started = await fetch(`${apiBase}/v1/widget/conversations`, {
    method: 'POST',
    headers: {
      ...headers,
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ clientMessageId: randomUUID(), firstMessage: text }),
  });
  expect(started.status, 'conversation started').toBe(201);
  return (await started.json()) as { id: string };
}

/** Waits until the AI has finished at least one run in the workspace. */
export async function waitForRun(staff: Staff) {
  await expect
    .poll(
      async () => {
        const runs = await staff.call<{ items: Array<{ state: string }> }>(
          'GET',
          '/v1/admin/runs?limit=5',
        );
        return runs.items.some((run) => run.state !== 'running');
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Runs SQL against the stack's throwaway database (sessions live in the auth schema). */
async function sql(text: string, params: unknown[]) {
  const db = createDb(stack().databaseUrl, { max: 1 });
  try {
    return await db.$client.query(text, params);
  } finally {
    await db.$client.end();
  }
}

const OWN_SESSIONS = `user_id = (SELECT id FROM auth."user" WHERE email = $1)`;

/** Makes the person's sign-in an hour old, so sensitive actions ask for a fresh one. */
export const ageSessions = (email: string) =>
  sql(`UPDATE auth.session SET created_at = now() - interval '1 hour' WHERE ${OWN_SESSIONS}`, [
    email,
  ]);

/** Ends every session of the person, as a sign-out elsewhere or an expiry would. */
export const endSessions = (email: string) =>
  sql(`DELETE FROM auth.session WHERE ${OWN_SESSIONS}`, [email]);

/** Marks the address as confirmed, as following the link in the confirmation email would. */
export const verifyEmail = (email: string) =>
  sql(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);

function base32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The current 6-digit code for a base32 TOTP secret (RFC 6238, SHA-1, 30 seconds). */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Presses Tab until `target` has focus; fails if it takes more than `limit` presses. */
export async function tabTo(page: Page, target: ReturnType<Page['locator']>, limit = 80) {
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab never reached ${target}`);
}

/**
 * Waits for loading states and entrance animations (a dialog fading in has not reached its real
 * colours yet), then lists every WCAG 2.2 A/AA violation axe finds.
 */
export async function audit(page: Page, label: string): Promise<string[]> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (v) =>
      `${label}: ${v.id} (${v.impact}) at ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}
