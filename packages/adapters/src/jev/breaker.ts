export interface BreakerOptions {
  /** Consecutive unavailable results that open the breaker. */
  failureThreshold: number;
  /** How long the breaker stays open before one probe may pass. */
  cooldownMs: number;
}

export type Admission =
  | { allowed: true; probe: boolean }
  | { allowed: false; retryAfterMs?: number };

/** A call that reached the provider (success), could not (failure), or says nothing about it. */
export type CallHealth = 'success' | 'failure' | 'neutral';

type State =
  | { name: 'closed'; failures: number }
  | { name: 'open'; since: number }
  | { name: 'half-open'; probing: boolean };

/**
 * Closed until `failureThreshold` consecutive failures, then open: calls are refused without
 * touching the network until `cooldownMs` has passed. Then one probe passes (half-open) while other
 * calls are still refused. The probe's success closes the breaker; its failure opens it again.
 */
export function createCircuitBreaker(options: BreakerOptions, clock: () => number) {
  const { failureThreshold, cooldownMs } = options;
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new TypeError('breaker.failureThreshold must be a positive integer');
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new TypeError('breaker.cooldownMs must be a non-negative number');
  }
  let state: State = { name: 'closed', failures: 0 };

  return {
    admit(): Admission {
      if (state.name === 'open') {
        const left = cooldownMs - (clock() - state.since);
        if (left > 0) return { allowed: false, retryAfterMs: Math.ceil(left) };
        state = { name: 'half-open', probing: false };
      }
      if (state.name === 'half-open') {
        if (state.probing) return { allowed: false };
        state = { name: 'half-open', probing: true };
        return { allowed: true, probe: true };
      }
      return { allowed: true, probe: false };
    },

    record(health: CallHealth, probe: boolean): void {
      if (probe) {
        if (health === 'success') state = { name: 'closed', failures: 0 };
        else if (health === 'failure') state = { name: 'open', since: clock() };
        else state = { name: 'half-open', probing: false };
        return;
      }
      // Late results of calls admitted before the breaker opened change nothing.
      if (state.name !== 'closed' || health === 'neutral') return;
      if (health === 'success') {
        state = { name: 'closed', failures: 0 };
        return;
      }
      const failures = state.failures + 1;
      state =
        failures >= failureThreshold
          ? { name: 'open', since: clock() }
          : { name: 'closed', failures };
    },
  };
}
