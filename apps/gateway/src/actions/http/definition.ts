import type { HttpToolBodyField, HttpToolParameter } from '@hamnivo/db/schema';
import {
  type PortableSchema,
  plainText,
  type RiskClass,
  sanitizeToolSchema,
} from '@hamnivo/domain/actions';
import { typeOfConverted } from './schema.js';

/**
 * What a custom HTTP tool is, whether it was written by hand or found in an OpenAPI description
 * (D10): a method, a path with `{placeholders}`, and arguments that each go to one place in the
 * request. This turns that into the rows a tool is stored as, and checks everything the request
 * builder later relies on, so a stored endpoint can always be sent.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ArgumentPlace = 'path' | 'query' | 'header' | 'body';

export const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** One argument of a tool: what the AI calls it, where it goes, and what it may be. */
export interface ToolArgument {
  name: string;
  in: ArgumentPlace;
  /** The name in the request (a query or header name, a body field, the `{placeholder}`). */
  key: string;
  required: boolean;
  /** A plain JSON Schema for the value; the portable subset has the last word on it. */
  schema: Record<string, unknown>;
}

export interface EndpointShape {
  method: HttpMethod;
  path: string;
  arguments: ToolArgument[];
}

export interface Assembled {
  method: HttpMethod;
  pathTemplate: string;
  parameters: HttpToolParameter[];
  bodyMode: 'none' | 'json';
  bodyFields: HttpToolBodyField[];
  inputSchema: PortableSchema;
}

/** Which part of an endpoint a problem is about, so a form can show it where it belongs. */
export type AssemblyField = 'path' | 'arguments';

export type Assembly =
  | { ok: true; value: Assembled }
  | { ok: false; problem: string; field: AssemblyField };

/** Headers that belong to the request itself or to the credential; no argument sets them. */
const FRAMING_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'expect',
  'content-type',
  'accept',
  'accept-encoding',
  'idempotency-key',
  'user-agent',
  'cookie',
  'set-cookie',
  'origin',
  'referer',
]);

/** A header an argument may not set: framing, and `Authorization` (the credential's). */
export const reservedHeader = (name: string) =>
  FRAMING_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'authorization';

/** A header a credential may travel in (`Authorization` included, framing headers excluded). */
export const credentialHeaderAllowed = (name: string) => !FRAMING_HEADERS.has(name.toLowerCase());

export const HEADER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Whether a text has a control character (a line break in a header, a NUL in a name). */
export function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
export const MAX_ARGUMENTS = 40;

const problem = (text: string, field: AssemblyField = 'arguments'): Assembly => ({
  ok: false,
  problem: text,
  field,
});

/** The `{names}` of a path, or null when its braces do not pair up. */
function placeholdersOf(path: string): string[] | null {
  const names: string[] = [];
  const rest = path.replace(/\{([^{}/]*)\}/g, (_whole, name: string) => {
    names.push(name);
    return '';
  });
  return rest.includes('{') || rest.includes('}') ? null : names;
}

/** Checks an endpoint and turns it into what is stored. */
export function assemble(shape: EndpointShape): Assembly {
  const { method, path } = shape;
  if (!path.startsWith('/')) return problem('The path must start with /.', 'path');
  const holders = placeholdersOf(path);
  if (!holders) return problem('The path has a { or } that is not part of a {name}.', 'path');
  for (const name of holders) {
    if (!PLACEHOLDER_NAME.test(name)) {
      return problem(`{${name}} is not a name a path can have.`, 'path');
    }
  }
  if (new Set(holders).size !== holders.length) {
    return problem('A {name} appears twice in the path.', 'path');
  }
  const segments = path.split('/').map((segment) => segment.toLowerCase());
  if (segments.some((s) => s === '.' || s === '..' || s === '%2e' || s === '%2e%2e')) {
    return problem('The path cannot have . or .. in it.', 'path');
  }
  if (shape.arguments.length > MAX_ARGUMENTS) {
    return problem(`A tool can have at most ${MAX_ARGUMENTS} arguments.`);
  }

  const names = new Set<string>();
  const wire = new Set<string>();
  const parameters: HttpToolParameter[] = [];
  const bodyFields: HttpToolBodyField[] = [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const argument of shape.arguments) {
    if (!ARGUMENT_NAME.test(argument.name)) {
      return problem(`“${plainText(argument.name, 40)}” is not a name an argument can have.`);
    }
    if (names.has(argument.name)) return problem(`Two arguments are called ${argument.name}.`);
    names.add(argument.name);
    const key = argument.key;
    if (key.length === 0 || key.length > 100 || hasControl(key)) {
      return problem(`The request name of ${argument.name} is not valid.`);
    }
    const id = `${argument.in}:${argument.in === 'header' ? key.toLowerCase() : key}`;
    if (wire.has(id)) return problem(`Two arguments go to ${argument.in} “${key}”.`);
    wire.add(id);
    const type = typeOfConverted(argument.schema);
    if (argument.in === 'path') {
      if (!holders.includes(key)) {
        return problem(`${argument.name} is for the path, but the path has no {${key}}.`);
      }
      if (type === 'array' || type === 'object') {
        return problem(`${argument.name} is in the path, so it must be a single value.`);
      }
    } else if (argument.in === 'header') {
      if (!HEADER_NAME.test(key)) return problem(`“${key}” is not a header name.`);
      if (reservedHeader(key)) return problem(`The ${key} header is set by Hamnivo.`);
      if (type === 'array' || type === 'object') {
        return problem(`${argument.name} is in a header, so it must be a single value.`);
      }
    } else if (argument.in === 'query') {
      if (type === 'object')
        return problem(`${argument.name} is in the query, so it cannot be an object.`);
    } else if (!BODY_METHODS.has(method)) {
      return problem(`A ${method} request has no body for ${argument.name} to go in.`);
    }
    const mustHave = argument.required || argument.in === 'path';
    if (argument.in === 'body') bodyFields.push({ argument: argument.name, key });
    else
      parameters.push({ name: key, in: argument.in, argument: argument.name, required: mustHave });
    properties[argument.name] = argument.schema;
    if (mustHave) required.push(argument.name);
  }
  for (const name of holders) {
    if (!shape.arguments.some((a) => a.in === 'path' && a.key === name)) {
      return problem(`The path has {${name}}, but no argument fills it in.`);
    }
  }
  const parsed = sanitizeToolSchema(
    { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    { trusted: false },
  );
  if (!parsed.ok) return problem(`The arguments cannot be described: ${parsed.problem}`);
  return {
    ok: true,
    value: {
      method,
      pathTemplate: path,
      parameters,
      bodyMode: bodyFields.length > 0 ? 'json' : 'none',
      bodyFields,
      inputSchema: parsed.schema,
    },
  };
}

/** What a request of this method does, unless a person says otherwise. */
export const defaultRisk = (method: HttpMethod): RiskClass =>
  method === 'GET' ? 'read' : method === 'DELETE' ? 'irreversible' : 'write';

/** `getOrderById` and `get-order-by-id` both read `get_order_by_id`. */
export function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The name a tool gets from its operation's id, or from its method and path without one. */
export function baseToolName(operationId: string | null, method: string, path: string): string {
  const named = operationId ? snake(operationId) : '';
  const text = named || snake(`${method} ${path.replace(/[{}]/g, ' ')}`);
  const name = text.replace(/^[^a-z]+/, '').slice(0, 56);
  return name.length >= 2 ? name : `${method.toLowerCase()}_request`;
}

/** The first of `name`, `name_2`, `name_3`… that is not taken. */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base.slice(0, 60)}_${n}`;
    if (!taken.has(next)) return next;
  }
}

/** The arguments of a tool as the portable schema stores them, for lists and for the edit form. */
export interface StoredArgument {
  name: string;
  in: ArgumentPlace;
  key: string;
  required: boolean;
  type: string;
  description: string | null;
}

export function argumentsOf(
  inputSchema: PortableSchema,
  parameters: readonly HttpToolParameter[],
  bodyFields: readonly HttpToolBodyField[],
): StoredArgument[] {
  const properties = inputSchema.properties ?? {};
  const required = new Set(inputSchema.required ?? []);
  const describe = (name: string, place: ArgumentPlace, key: string): StoredArgument => {
    const schema = properties[name];
    return {
      name,
      in: place,
      key,
      required: required.has(name),
      type: schema?.type ?? 'string',
      description: schema?.description ?? null,
    };
  };
  return [
    ...parameters.map((p) => describe(p.argument, p.in, p.name)),
    ...bodyFields.map((f) => describe(f.argument, 'body', f.key)),
  ];
}
