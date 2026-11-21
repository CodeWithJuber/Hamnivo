import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/common/app-error.js';
import type { AppConfig } from '../src/config.js';
import { ErrorReportsController } from '../src/observability/error-reports.controller.js';
import { envelopeTarget, sameProject } from '../src/observability/error-reports.js';

const DSN = 'https://pubkey@errors.example.com/42';
const envelope = (dsn: string) =>
  `${JSON.stringify({ event_id: 'a'.repeat(32), dsn })}\n{"type":"event"}\n{"message":"boom"}`;

describe('where an error report may go', () => {
  it('goes to the envelope endpoint of the configured project, with its key', () => {
    expect(envelopeTarget(envelope(DSN), DSN)?.href).toBe(
      'https://errors.example.com/api/42/envelope/?sentry_key=pubkey',
    );
  });

  it('keeps a path prefix, as a self-hosted GlitchTip behind /errors has', () => {
    const dsn = 'https://k@host.example/errors/7';
    expect(envelopeTarget(envelope(dsn), dsn)?.href).toBe(
      'https://host.example/errors/api/7/envelope/?sentry_key=k',
    );
  });

  it('refuses an envelope for any other project, key or host, so it is never an open relay', () => {
    for (const other of [
      'https://pubkey@errors.example.com/43',
      'https://otherkey@errors.example.com/42',
      'https://pubkey@attacker.example/42',
      'http://pubkey@errors.example.com/42',
    ]) {
      expect(envelopeTarget(envelope(other), DSN)).toBeNull();
    }
  });

  it('refuses what is not an envelope', () => {
    expect(envelopeTarget('not json\n{}', DSN)).toBeNull();
    expect(envelopeTarget('{"event_id":"x"}\n{}', DSN)).toBeNull();
    expect(envelopeTarget('null', DSN)).toBeNull();
  });

  it('treats a trailing slash as the same project', () => {
    expect(sameProject(`${DSN}/`, DSN)).toBe(true);
    expect(sameProject('not a dsn', DSN)).toBe(false);
  });
});

describe('the error report tunnel', () => {
  afterEach(() => vi.unstubAllGlobals());

  const controller = (dsn?: string) =>
    new ErrorReportsController({
      NODE_ENV: 'production',
      ...(dsn ? { SENTRY_DSN: dsn } : {}),
    } as AppConfig);
  const request = (body: unknown) =>
    ({ body, log: { warn: vi.fn() } }) as unknown as FastifyRequest;
  const reply = () => {
    const headers: Record<string, string> = {};
    const fake = {
      headers,
      header(name: string, value: string) {
        headers[name] = value;
        return fake;
      },
    };
    return fake;
  };
  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'ok';
    } catch (error) {
      return error instanceof AppError ? error.code : String(error);
    }
  };

  it('tells pages whether error tracking is on', () => {
    expect(controller().settings()).toMatchObject({ dsn: null, environment: 'production' });
    expect(controller(DSN).settings().dsn).toBe(DSN);
  });

  it('forwards only the envelope body to the project', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const body = envelope(DSN);
    const result = await codeOf(
      controller(DSN).forward(request(body), reply() as unknown as FastifyReply),
    );
    expect(result).toBe('ok');
    expect(fetch).toHaveBeenCalledOnce();
    const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(target)).toBe('https://errors.example.com/api/42/envelope/?sentry_key=pubkey');
    expect(init.body).toBe(body);
    expect(init.headers).toEqual({ 'content-type': 'application/x-sentry-envelope' });
  });

  it('sends nothing when tracking is off, or the envelope is for someone else', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const r = reply() as unknown as FastifyReply;
    expect(await codeOf(controller().forward(request(envelope(DSN)), r))).toBe('NOT_FOUND');
    const other = envelope('https://pubkey@attacker.example/42');
    expect(await codeOf(controller(DSN).forward(request(other), r))).toBe('VALIDATION_FAILED');
    expect(await codeOf(controller(DSN).forward(request({ json: true }), r))).toBe(
      'VALIDATION_FAILED',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes on when the tracker asks to slow down, and says when it cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('', {
            status: 429,
            headers: { 'retry-after': '30', 'x-sentry-rate-limits': '30:error' },
          }),
      ),
    );
    const slow = reply();
    const tunnel = controller(DSN);
    expect(
      await codeOf(tunnel.forward(request(envelope(DSN)), slow as unknown as FastifyReply)),
    ).toBe('RATE_LIMITED');
    expect(slow.headers['x-sentry-rate-limits']).toBe('30:error');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(
      await codeOf(tunnel.forward(request(envelope(DSN)), reply() as unknown as FastifyReply)),
    ).toBe('PROVIDER_UNAVAILABLE');
  });
});
