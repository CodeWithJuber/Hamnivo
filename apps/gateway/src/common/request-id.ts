import { newId, toPublicId } from '@hamnivo/db';

const INCOMING = /^[A-Za-z0-9._:-]{8,128}$/;

/** Uses a well-formed incoming X-Request-Id (from a proxy) or mints `req_…`. */
export function requestIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && INCOMING.test(value) ? value : toPublicId('request', newId());
}
