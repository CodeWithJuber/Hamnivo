import { ApiError } from './api';

/**
 * `step-up`: the session is valid but too old for a sensitive action (REAUTH_REQUIRED).
 * `expired`: the session is gone (AUTH_REQUIRED, SESSION_EXPIRED).
 * Both are solved by signing in again in a dialog; the page and its unsaved work stay underneath.
 */
export type ReauthReason = 'step-up' | 'expired';

export interface ReauthRequest {
  reason: ReauthReason;
}

export class ReauthCancelled extends Error {
  override name = 'ReauthCancelled';
}

interface Pending extends ReauthRequest {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

type Listener = () => void;

class ReauthStore {
  private pending: Pending | null = null;
  private snapshotValue: ReauthRequest | null = null;
  private paused = false;
  private readonly listeners = new Set<Listener>();

  /**
   * Someone is signing out on purpose: requests still in flight will fail as signed out, and must
   * not open "sign in to continue" over the sign-in page. Lasts until the next sign-in.
   */
  pause() {
    this.paused = true;
    this.cancel();
  }

  resume() {
    this.paused = false;
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The open request, or null (stable between changes, for useSyncExternalStore). */
  snapshot = () => this.snapshotValue;

  private emit() {
    this.snapshotValue = this.pending ? { reason: this.pending.reason } : null;
    for (const listener of this.listeners) listener();
  }

  /** Opens the dialog, or joins the one already open. Resolves after a successful sign-in. */
  request(reason: ReauthReason): Promise<void> {
    if (this.paused) return Promise.reject(new ReauthCancelled());
    if (this.pending) {
      // An ended session outranks a step-up; both are fixed by the same sign-in.
      if (reason === 'expired' && this.pending.reason === 'step-up') {
        this.pending.reason = 'expired';
        this.emit();
      }
      return this.pending.promise;
    }
    let resolve: () => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    this.pending = { reason, promise, resolve, reject };
    this.emit();
    return promise;
  }

  succeed() {
    const pending = this.pending;
    this.pending = null;
    this.emit();
    pending?.resolve();
  }

  cancel() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.emit();
    pending.reject(new ReauthCancelled());
  }
}

export const reauth = new ReauthStore();

/**
 * Runs an API action; when the gateway asks for a fresh sign-in, opens the sign-in dialog and
 * repeats the same action once the person has signed in. Cancelling rejects with ReauthCancelled
 * and leaves everything as it was.
 */
export async function withReauth<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ApiError) || attempt >= 2) throw error;
      if (error.code === 'REAUTH_REQUIRED') await reauth.request('step-up');
      else if (error.code === 'AUTH_REQUIRED' || error.code === 'SESSION_EXPIRED') {
        await reauth.request('expired');
      } else throw error;
    }
  }
}

export const isCancelled = (error: unknown) => error instanceof ReauthCancelled;
