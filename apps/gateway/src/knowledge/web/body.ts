import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

/** A response body that cannot be read as it is: too large once unpacked, or not unpackable. */
export class BodyError extends Error {
  override readonly name = 'BodyError';
}

/**
 * Unpacks a response body that was compressed (`Content-Encoding`), never past `maxBytes`: a small
 * body that unpacks to a huge one is refused instead of filling memory.
 */
export function unpack(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const kind = (encoding ?? '').trim().toLowerCase();
  if (kind === '' || kind === 'identity') return body;
  const options = { maxOutputLength: maxBytes };
  try {
    if (kind === 'gzip' || kind === 'x-gzip') return gunzipSync(body, options);
    if (kind === 'deflate') return inflateSync(body, options);
    if (kind === 'br') return brotliDecompressSync(body, options);
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new BodyError('The page is too large.');
    }
    throw new BodyError('The page could not be unpacked.');
  }
  throw new BodyError('The page uses a compression Hamnivo cannot read.');
}

/** Unpacks a `.gz` file (a compressed sitemap), whatever the server said about it. */
export function gunzip(body: Buffer, maxBytes: number): Buffer {
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) return body;
  return unpack(body, 'gzip', maxBytes);
}

const CHARSET = /charset\s*=\s*["']?([a-z0-9_.:-]+)/i;

/** The character set a page says it is written in: its headers first, then its first bytes. */
function declaredCharset(bytes: Buffer, contentType: string | undefined): string | null {
  const fromHeader = CHARSET.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const head = bytes.subarray(0, 2048).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?([a-z0-9_.:-]+)/i.exec(head)?.[1] ?? null;
}

/**
 * The page as UTF-8 text, whatever it was written in: a page in Windows-1256 or ISO-8859-1 becomes
 * text the ingestion reads, and bytes that are not valid in the declared set become replacement
 * characters instead of making the page unreadable.
 */
export function toUtf8(bytes: Buffer, contentType: string | undefined): Buffer {
  const declared = declaredCharset(bytes, contentType);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(declared ?? 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return Buffer.from(decoder.decode(bytes), 'utf8');
}
