/**
 * Bad input to @hamnivo/server. The message says what to change, and nothing was signed. Messages
 * never repeat the values passed in, so they are safe to log even when a secret was put in the
 * wrong place.
 */
export class HamnivoIdentityError extends Error {
  override name = 'HamnivoIdentityError';
}

export function invalid(message: string, cause?: unknown): HamnivoIdentityError {
  return new HamnivoIdentityError(message, cause === undefined ? undefined : { cause });
}

export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
