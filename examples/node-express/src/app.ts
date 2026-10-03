import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import {
  createIdentityAssertion,
  HamnivoWebhookError,
  type HamnivoWebhookEvent,
  type IdentitySigningKey,
  MemoryReplayStore,
  verifyWebhook,
} from '@hamnivo/server';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { renderPage } from './page.js';
import { USERS, type User } from './users.js';

export interface AppOptions {
  /** The brand's widget ID (`wid_…`). */
  widgetId: string;
  /** Where Hamnivo Chat and its loader.js are served. */
  widgetOrigin: string;
  /** The Hamnivo API. */
  api: string;
  /** The identity key registered for the brand. It never leaves this server. */
  key: IdentitySigningKey;
  /**
   * The webhook endpoint's `whsec_…` signing secret (both secrets while rotating). Without it the
   * webhook route is not mounted.
   */
  webhookSecret?: string | readonly string[];
  /** What to do with a verified event (default: log its type and id). */
  onWebhook?: (event: HamnivoWebhookEvent) => void | Promise<void>;
}

const COOKIE = 'example_session';

export function createApp({
  widgetId,
  widgetOrigin,
  api,
  key,
  webhookSecret,
  onWebhook = (event) => void process.stdout.write(`webhook ${event.type} ${event.id}\n`),
}: AppOptions): Express {
  // Signs the sign-in cookie. It is new on every start, so a restart signs everyone out.
  const cookieSecret = randomBytes(32);
  const currentUser = (req: Request) => signedInUser(cookieSecret, req.headers.cookie);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(join(import.meta.dirname, '../public')));
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (req, res) => {
    res.type('html').send(renderPage({ widgetId, widgetOrigin, api, user: currentUser(req) }));
  });

  // A fake sign-in: a signed cookie holding the user id. Use your website's real sign-in instead.
  app.post('/sign-in', (req, res) => {
    const user = USERS.find((u) => u.id === req.body?.userId);
    if (!user) {
      res.status(400).send('Unknown user.');
      return;
    }
    res.cookie(COOKIE, signedValue(cookieSecret, user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      path: '/',
    });
    res.redirect(303, '/');
  });

  app.post('/sign-out', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/');
  });

  // The one route Hamnivo needs: a fresh identity assertion for the signed-in customer.
  app.get('/hamnivo/identity', async (req, res) => {
    res.set('cache-control', 'no-store');
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in first.' });
      return;
    }
    // Everything signed comes from this server's records, never from the request.
    const assertion = await createIdentityAssertion({
      widgetId,
      key,
      customer: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
      },
    });
    res.json({ assertion });
  });

  // Webhooks from Hamnivo: verified on the raw body, then handled once per event id.
  if (webhookSecret) {
    const replayStore = new MemoryReplayStore();
    app.post('/hamnivo/webhooks', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
      let event: HamnivoWebhookEvent;
      try {
        const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
        event = await verifyWebhook(body, req.headers, { secret: webhookSecret, replayStore });
      } catch (error) {
        if (error instanceof HamnivoWebhookError && error.code === 'duplicate') {
          // Already handled: 2xx stops Hamnivo from sending it again.
          res.sendStatus(200);
          return;
        }
        if (error instanceof HamnivoWebhookError) {
          res.status(400).json({ error: error.code });
          return;
        }
        throw error;
      }
      try {
        await onWebhook(event);
      } catch (error) {
        // Not handled: forget the id so Hamnivo's retry is processed, and say so with a 5xx.
        await replayStore.release(event.id);
        throw error;
      }
      res.sendStatus(204);
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // The reason stays in the server log; the browser gets no details.
    console.error(error);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}

function signedValue(secret: Buffer, userId: string): string {
  return `${userId}.${createHmac('sha256', secret).update(userId).digest('base64url')}`;
}

/** The user in a correctly signed cookie. A cookie the browser made up or changed is ignored. */
function signedInUser(secret: Buffer, cookieHeader: string | undefined): User | undefined {
  const value = readCookie(cookieHeader, COOKIE);
  const dot = value?.lastIndexOf('.') ?? -1;
  if (!value || dot < 1) return undefined;
  const userId = value.slice(0, dot);
  const expected = Buffer.from(signedValue(secret, userId));
  const actual = Buffer.from(value);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  return USERS.find((u) => u.id === userId);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const pair of header?.split(';') ?? []) {
    const equals = pair.indexOf('=');
    if (equals > 0 && pair.slice(0, equals).trim() === name) return pair.slice(equals + 1).trim();
  }
  return undefined;
}
