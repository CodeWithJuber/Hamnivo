import type { HttpToolBodyField, HttpToolParameter } from '@hamnivo/db/schema';
import { type HttpMethod, hasControl } from './definition.js';

/**
 * The request a custom HTTP tool call becomes (D10), and what the answer to it means. Nothing
 * here touches the network: the address is built from the stored endpoint and the arguments the
 * gateway already checked, and it can never leave the service's own address. Values that would
 * change the shape of the request (a `..` in a path, a line break in a header) are refused before
 * anything is sent.
 */

/** The arguments do not make a request that may be sent; nothing was sent. */
export class HttpArgumentError extends Error {
  override readonly name = 'HttpArgumentError';
}

export interface EndpointRequestShape {
  method: HttpMethod;
  pathTemplate: string;
  parameters: readonly HttpToolParameter[];
  bodyMode: 'none' | 'json';
  bodyFields: readonly HttpToolBodyField[];
}

export interface BuiltRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
}

const MAX_URL = 4000;
const MAX_PART = 500;

function scalar(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new HttpArgumentError(`${name} must be a single value.`);
}

/** Builds the request of one call from the stored endpoint, the service's address and the arguments. */
export function buildRequest(
  shape: EndpointRequestShape,
  baseUrl: string,
  args: Readonly<Record<string, unknown>>,
): BuiltRequest {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');

  const path = shape.pathTemplate.replace(/\{([^{}]*)\}/g, (_whole, name: string) => {
    const parameter = shape.parameters.find((p) => p.in === 'path' && p.name === name);
    if (!parameter) throw new HttpArgumentError('The path has a part that nothing fills in.');
    const value = args[parameter.argument];
    if (value === undefined || value === null) {
      throw new HttpArgumentError(`${parameter.argument} is needed.`);
    }
    const text = scalar(value, parameter.argument);
    // A `.` or `..` would walk up the path of the service: it is never a value of a path part.
    if (text === '' || text === '.' || text === '..' || text.length > MAX_PART) {
      throw new HttpArgumentError(`${parameter.argument} is not a value the path can take.`);
    }
    return encodeURIComponent(text);
  });

  const query = new URLSearchParams();
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.5' };
  for (const parameter of shape.parameters) {
    if (parameter.in === 'path') continue;
    const value = args[parameter.argument];
    if (value === undefined || value === null) {
      if (parameter.required) throw new HttpArgumentError(`${parameter.argument} is needed.`);
      continue;
    }
    if (parameter.in === 'query') {
      for (const item of Array.isArray(value) ? value : [value]) {
        const text = scalar(item, parameter.argument);
        if (text.length > MAX_PART)
          throw new HttpArgumentError(`${parameter.argument} is too long.`);
        query.append(parameter.name, text);
      }
    } else {
      const text = scalar(value, parameter.argument);
      if (hasControl(text) || text.length > MAX_PART) {
        throw new HttpArgumentError(`${parameter.argument} is not a value a header can take.`);
      }
      headers[parameter.name.toLowerCase()] = text;
    }
  }

  let body: string | undefined;
  if (shape.bodyMode === 'json') {
    const fields = shape.bodyFields.flatMap((field) =>
      args[field.argument] === undefined ? [] : [[field.key, args[field.argument]] as const],
    );
    // fromEntries defines every key as data, whatever it is called.
    body = JSON.stringify(Object.fromEntries(fields));
    headers['content-type'] = 'application/json';
  }

  const search = query.toString();
  const target = new URL(`${base.origin}${basePath}${path}${search ? `?${search}` : ''}`);
  const inside =
    basePath === '' || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
  if (target.origin !== base.origin || !inside || target.href.length > MAX_URL) {
    throw new HttpArgumentError('The request would not stay inside the service’s address.');
  }
  return {
    url: target.href,
    method: shape.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

/** What the service's answer to a call means. */
export type HttpVerdict =
  /** The service did it. `output` is what it said, as data. */
  | { kind: 'ok'; output: unknown }
  /** The service refused or could not start: nothing was done. */
  | { kind: 'refused'; reason: string; status: number; credential: boolean }
  /** The service may have done it (an error after it started, or a redirect). */
  | { kind: 'unsure'; reason: string; status: number };

export interface HttpAnswer {
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

/** How much of a text answer is kept (the tool's own output limit applies on top). */
const TEXT_CHARS = 8000;

const isJson = (type: string) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(type);
const isText = (type: string) =>
  /^text\//i.test(type) || /^application\/(?:[\w.+-]+\+)?(?:xml|yaml|x-yaml)\b/i.test(type);

/** The answer's body as data: JSON as it is, text as `{ text }`, a file as a short note. */
function bodyOf(answer: HttpAnswer): unknown {
  if (answer.body.length === 0) return { status: answer.status };
  if (isJson(answer.contentType) && !answer.truncated) {
    try {
      return JSON.parse(answer.body.toString('utf8'));
    } catch {
      // Not JSON after all: read as text below.
    }
  }
  if (isJson(answer.contentType) || isText(answer.contentType)) {
    return {
      text: answer.body.toString('utf8').slice(0, TEXT_CHARS),
      ...(answer.truncated ? { truncated: true } : {}),
    };
  }
  return {
    note: `The service answered with a file of ${answer.body.length} bytes that cannot be read as text.`,
  };
}

/** What a response means: done, refused (nothing happened), or unsure (it may have happened). */
export function interpret(answer: HttpAnswer): HttpVerdict {
  const { status } = answer;
  if (status >= 200 && status < 300) return { kind: 'ok', output: bodyOf(answer) };
  if (status === 401 || status === 403) {
    return { kind: 'refused', reason: 'auth', status, credential: true };
  }
  if (status >= 300 && status < 400) return { kind: 'unsure', reason: 'redirect', status };
  if (status >= 400 && status < 500) {
    return {
      kind: 'refused',
      reason: status === 429 ? 'rate_limited' : `http_${status}`,
      status,
      credential: false,
    };
  }
  if (status === 501) return { kind: 'refused', reason: 'http_501', status, credential: false };
  return { kind: 'unsure', reason: 'server_error', status };
}
