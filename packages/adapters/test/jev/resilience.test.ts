import { describe, expect, it } from 'vitest';
import { fakeJev, jevWith, request } from './helpers.js';

// Real timers: AbortSignal.timeout is not affected by fake timers.
const MARGIN_MS = 150;

describe('total deadline (J06)', () => {
  it('resolves unavailable within the deadline when Jev is slow', async () => {
    const { fetch } = fakeJev({ delayMs: 5_000 });
    const started = performance.now();
    const result = await jevWith(fetch, { deadlineMs: 100 }).decide(request);
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ status: 'unavailable', retryable: true, reason: 'deadline' });
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(100 + MARGIN_MS);
  });

  it('holds even when the transport ignores cancellation', async () => {
    const { fetch } = fakeJev({ delayMs: 600, ignoreAbort: true });
    const started = performance.now();
    const result = await jevWith(fetch, { deadlineMs: 100 }).decide(request);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'deadline' });
    expect(performance.now() - started).toBeLessThan(100 + MARGIN_MS);
  });

  it('uses the default 1.5 s budget, and a per-request deadline when given', async () => {
    const { fetch } = fakeJev({ delayMs: 5_000 });
    const started = performance.now();
    const result = await jevWith(fetch).decide({ ...request, deadlineMs: 80 });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'deadline' });
    expect(performance.now() - started).toBeLessThan(80 + MARGIN_MS);
  });
});

describe('cancellation (J06)', () => {
  it('a caller abort mid-call is unavailable and not retryable', async () => {
    const { fetch } = fakeJev({ delayMs: 5_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = performance.now();
    const result = await jevWith(fetch).decide({ ...request, signal: controller.signal });
    expect(result).toMatchObject({ status: 'unavailable', retryable: false, reason: 'aborted' });
    expect(performance.now() - started).toBeLessThan(30 + MARGIN_MS);
  });

  it('an already-aborted call never reaches the network', async () => {
    const { fetch, calls } = fakeJev({});
    const result = await jevWith(fetch).decide({ ...request, signal: AbortSignal.abort() });
    expect(result).toMatchObject({ status: 'unavailable', retryable: false, reason: 'aborted' });
    expect(calls).toHaveLength(0);
  });
});

describe('circuit breaker (J06)', () => {
  const breaker = { failureThreshold: 2, cooldownMs: 1_000 };

  it('opens after consecutive failures, probes once after the cooldown and closes on success', async () => {
    let now = 0;
    const { fetch, calls } = fakeJev({ status: 503 }, { status: 503 }, { status: 503 }, {});
    const jev = jevWith(fetch, { breaker, clock: () => now });

    expect(await jev.decide(request)).toMatchObject({ reason: 'server_error' });
    expect(await jev.decide(request)).toMatchObject({ reason: 'server_error' });
    now = 400;
    expect(await jev.decide(request)).toMatchObject({
      status: 'unavailable',
      retryable: true,
      reason: 'circuit_open',
      retryAfterMs: 600,
    });
    expect(calls).toHaveLength(2);

    now = 1_000; // Cooldown over: one probe, which fails and opens the breaker again.
    expect(await jev.decide(request)).toMatchObject({ reason: 'server_error' });
    expect(await jev.decide(request)).toMatchObject({
      reason: 'circuit_open',
      retryAfterMs: 1_000,
    });
    expect(calls).toHaveLength(3);

    now = 2_000; // The next probe succeeds and closes it.
    expect(await jev.decide(request)).toMatchObject({ status: 'decided' });
    expect(await jev.decide(request)).toMatchObject({ status: 'decided' });
    expect(calls).toHaveLength(5);
  });

  it('lets a single probe through while half-open', async () => {
    let now = 0;
    const { fetch, calls } = fakeJev({ status: 503 }, { status: 503 }, { delayMs: 50 }, {});
    const jev = jevWith(fetch, { breaker, clock: () => now });
    await jev.decide(request);
    await jev.decide(request);
    now = 1_000;
    const probe = jev.decide(request);
    expect(await jev.decide(request)).toMatchObject({ reason: 'circuit_open' });
    expect(await probe).toMatchObject({ status: 'decided' });
    expect(await jev.decide(request)).toMatchObject({ status: 'decided' });
    expect(calls).toHaveLength(4);
  });

  it('does not count caller aborts as failures, and a reachable Jev resets the count', async () => {
    const { fetch, calls } = fakeJev(
      { status: 503 },
      { delayMs: 5_000 },
      { status: 400, body: { error: 'bad' } },
      { status: 503 },
      {},
    );
    const jev = jevWith(fetch, { breaker, clock: () => 0 });
    expect(await jev.decide(request)).toMatchObject({ reason: 'server_error' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    expect(await jev.decide({ ...request, signal: controller.signal })).toMatchObject({
      reason: 'aborted',
    });
    expect(await jev.decide(request)).toMatchObject({ status: 'invalid' });
    expect(await jev.decide(request)).toMatchObject({ reason: 'server_error' });
    expect(await jev.decide(request)).toMatchObject({ status: 'decided' });
    expect(calls).toHaveLength(5);
  });
});
