import { createHash } from 'node:crypto';
import { plainText, type RiskClass } from '@hamnivo/domain/actions';
import { load } from 'js-yaml';
import {
  type ArgumentPlace,
  type Assembled,
  assemble,
  BODY_METHODS,
  baseToolName,
  credentialHeaderAllowed,
  defaultRisk,
  HEADER_NAME,
  type HttpMethod,
  MAX_ARGUMENTS,
  reservedHeader,
  type ToolArgument,
} from './definition.js';
import {
  convertSchema,
  deref,
  isRecord,
  objectFields,
  readContext,
  SpecTooComplex,
  spend,
  typeOfConverted,
} from './schema.js';

/**
 * Reading an OpenAPI 3 description (D10, custom HTTP tools): which of its operations can become
 * tools, and what each tool's arguments would be. It is JSON or YAML written by somebody else,
 * so nothing in it is trusted: texts lose control characters and are cut short, only references
 * inside the document are followed, the work is capped, and an operation that cannot be sent
 * safely is listed as skipped with the reason instead of being half imported.
 */

/** The description cannot be read; the message is safe to show. */
export class SpecProblem extends Error {
  override readonly name = 'SpecProblem';
}

export interface ParsedOperation {
  /** `GET /orders/{orderId}`: how a selection names it. */
  key: string;
  method: HttpMethod;
  path: string;
  /** The operation's id in the description, or its key when it has none. */
  operationId: string;
  /** What the description called it, cut short and cleaned (untrusted text). */
  title: string;
  /** What the description said about it (untrusted text), for people to read quoted. */
  remoteDescription: string | null;
  /** The name a tool of it would get before names that are taken are avoided. */
  baseName: string;
  risk: RiskClass;
  assembled: Assembled;
  arguments: { name: string; in: ArgumentPlace; type: string; required: boolean }[];
  /** What was left out of it, and why. */
  notes: string[];
  /** SHA-256 of everything that makes the tool what it is. */
  digest: Buffer;
}

export interface ParsedSpec {
  openapi: string;
  title: string | null;
  version: string | null;
  /** SHA-256 of the text that was read, in hex. */
  hash: string;
  servers: string[];
  auth: { kind: 'none' | 'bearer' | 'header'; header: string | null; unsupported: string | null };
  operations: ParsedOperation[];
  skipped: { key: string; reason: string }[];
}

type Raw = Record<string, unknown>;

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_OPERATIONS = 1000;
const PATH_CHARS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/{}]*$/;
const NOT_READABLE = 'The description could not be read. Hamnivo reads OpenAPI 3 as JSON or YAML.';

function readDocument(text: string): Raw {
  const trimmed = text.trim();
  let doc: unknown;
  try {
    if (trimmed.startsWith('{')) {
      try {
        doc = JSON.parse(trimmed);
      } catch {
        doc = load(trimmed, { maxDepth: 64 });
      }
    } else {
      doc = load(trimmed, { maxDepth: 64 });
    }
  } catch {
    throw new SpecProblem(NOT_READABLE);
  }
  if (!isRecord(doc)) throw new SpecProblem(NOT_READABLE);
  return doc;
}

/** The first JSON content of a request body. */
function jsonContent(content: unknown): Raw | null {
  if (!isRecord(content)) return null;
  const exact = content['application/json'];
  if (isRecord(exact)) return exact;
  for (const [type, media] of Object.entries(content)) {
    if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(type) && isRecord(media)) return media;
  }
  return null;
}

/** A name an argument can have, from the name in the request, that is not taken. */
function argumentName(key: string, place: ArgumentPlace, taken: Set<string>): string {
  let base = key.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[A-Za-z]/.test(base)) base = `p_${base}`;
  base = base.slice(0, 56);
  let name = base;
  if (taken.has(name)) name = `${place}_${base}`.slice(0, 60);
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

type Skip = { skip: string };
type Read<T> = { ok: T } | Skip;
const skip = (reason: string): Skip => ({ skip: reason });
const failed = <T>(value: Read<T>): value is Skip => 'skip' in value;

const UNSUPPORTED_STYLES = new Set(['pipeDelimited', 'spaceDelimited', 'deepObject']);

/** The parameters of an operation, merged with those of its path, as arguments. */
function readParameters(
  ctx: ReturnType<typeof readContext>,
  item: Raw,
  operation: Raw,
  taken: Set<string>,
  notes: string[],
): Read<ToolArgument[]> {
  const merged = new Map<string, Raw>();
  for (const source of [item.parameters, operation.parameters]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      spend(ctx);
      const resolved = deref(ctx, entry);
      if (!resolved.ok) return skip(`A parameter could not be read (${resolved.reason}).`);
      const { name, in: place } = resolved.node;
      if (typeof name !== 'string' || typeof place !== 'string') {
        return skip('A parameter has no name or no place.');
      }
      merged.set(`${place}:${name}`, resolved.node);
    }
  }
  const out: ToolArgument[] = [];
  for (const parameter of merged.values()) {
    const name = parameter.name as string;
    const place = parameter.in as string;
    const required = place === 'path' || parameter.required === true;
    const leave = (reason: string): Skip | null => {
      if (required) return skip(`${name}: ${reason}.`);
      if (notes.length < 12) notes.push(`Left out ${name}: ${reason}.`);
      return null;
    };
    if (place !== 'path' && place !== 'query' && place !== 'header') {
      const refused = leave(
        place === 'cookie' ? 'tools cannot send cookies' : 'it is in a place tools cannot use',
      );
      if (refused) return refused;
      continue;
    }
    if (place === 'header' && reservedHeader(name)) {
      // The credential and the request's own headers are Hamnivo's to set.
      if (notes.length < 12) notes.push(`Left out the ${name} header: Hamnivo sets it itself.`);
      continue;
    }
    if (place === 'header' && !HEADER_NAME.test(name)) {
      const refused = leave('its name is not one a header can have here');
      if (refused) return refused;
      continue;
    }
    if (parameter.deprecated === true && !required) {
      if (notes.length < 12) notes.push(`Left out ${name}: it is deprecated.`);
      continue;
    }
    if (parameter.schema === undefined && parameter.content !== undefined) {
      const refused = leave('its format is not supported');
      if (refused) return refused;
      continue;
    }
    if (
      parameter.explode === false ||
      (typeof parameter.style === 'string' && UNSUPPORTED_STYLES.has(parameter.style))
    ) {
      const refused = leave('its list format is not supported');
      if (refused) return refused;
      continue;
    }
    const converted = convertSchema(ctx, parameter.schema ?? { type: 'string' }, 1, notes, name);
    if (!converted.ok) {
      const refused = leave(converted.reason);
      if (refused) return refused;
      continue;
    }
    const type = typeOfConverted(converted.schema);
    if (type === 'object' || (type === 'array' && place !== 'query')) {
      const refused = leave(
        type === 'object' ? 'it is an object' : 'a list is only supported in the query',
      );
      if (refused) return refused;
      continue;
    }
    const description =
      typeof parameter.description === 'string' && parameter.description.trim()
        ? plainText(parameter.description, 500)
        : undefined;
    out.push({
      name: argumentName(name, place, taken),
      in: place,
      key: name,
      required,
      schema: { ...converted.schema, ...(description ? { description } : {}) },
    });
  }
  return { ok: out };
}

/** The fields of a JSON request body as arguments. */
function readBody(
  ctx: ReturnType<typeof readContext>,
  operation: Raw,
  method: HttpMethod,
  taken: Set<string>,
  notes: string[],
): Read<ToolArgument[]> {
  if (operation.requestBody === undefined) return { ok: [] };
  const resolved = deref(ctx, operation.requestBody);
  if (!resolved.ok) return skip(`The request body could not be read (${resolved.reason}).`);
  const mandatory = resolved.node.required === true;
  const leave = (reason: string): Read<ToolArgument[]> => {
    if (mandatory) return skip(`${reason}.`);
    if (notes.length < 12) notes.push(`Left out the request body: ${reason}.`);
    return { ok: [] };
  };
  if (!BODY_METHODS.has(method)) return leave(`a ${method} request with a body is not supported`);
  const media = jsonContent(resolved.node.content);
  if (!media) return leave('only JSON request bodies are supported');
  if (media.schema === undefined) return leave('it does not say what the fields are');
  const fields = objectFields(ctx, media.schema);
  if (!fields.ok) return leave(`it is not a JSON object with named fields (${fields.reason})`);
  const names = Object.keys(fields.properties).sort();
  if (names.length > MAX_ARGUMENTS)
    return skip(`The request body has more than ${MAX_ARGUMENTS} fields.`);
  const out: ToolArgument[] = [];
  for (const key of names) {
    const required = fields.required.has(key);
    const converted = convertSchema(ctx, fields.properties[key], 1, notes, key);
    if (!converted.ok) {
      if (required) return skip(`${key}: ${converted.reason}.`);
      if (notes.length < 12) notes.push(`Left out ${key}: ${converted.reason}.`);
      continue;
    }
    out.push({
      name: argumentName(key, 'body', taken),
      in: 'body',
      key,
      required,
      schema: converted.schema,
    });
  }
  if (out.length === 0) return leave('none of its fields can be used');
  return { ok: out };
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = plainText(value, max);
  return text === '' ? null : text;
}

function readOperation(
  ctx: ReturnType<typeof readContext>,
  method: HttpMethod,
  path: string,
  item: Raw,
  operation: Raw,
  names: Set<string>,
): { operation: ParsedOperation } | { skip: string } {
  const key = `${method} ${path}`;
  if (operation.deprecated === true) return skip('Marked as deprecated in the description.');
  if (!PATH_CHARS.test(path)) return skip('The path has characters Hamnivo does not send.');
  const notes: string[] = [];
  const taken = new Set<string>();
  const parameters = readParameters(ctx, item, operation, taken, notes);
  if (failed(parameters)) return parameters;
  const body = readBody(ctx, operation, method, taken, notes);
  if (failed(body)) return body;
  const args = [...parameters.ok, ...body.ok];
  const assembled = assemble({ method, path, arguments: args });
  if (!assembled.ok) return skip(assembled.problem);

  const operationId = clean(operation.operationId, 120);
  const summary = clean(operation.summary, 200);
  const long = clean(operation.description, 2000);
  const title = clean(summary ?? operationId ?? key, 120) ?? key;
  const remoteDescription = long ?? summary;
  const baseName = baseToolName(operationId, method, path);
  const unique = (() => {
    let name = baseName;
    for (let n = 2; names.has(name); n += 1) name = `${baseName.slice(0, 56)}_${n}`;
    names.add(name);
    return name;
  })();
  return {
    operation: {
      key,
      method,
      path,
      operationId: operationId ?? key,
      title,
      remoteDescription,
      baseName: unique,
      risk: defaultRisk(method),
      assembled: assembled.value,
      arguments: args.map((a) => ({
        name: a.name,
        in: a.in,
        type: typeOfConverted(a.schema),
        required: a.required || a.in === 'path',
      })),
      notes,
      digest: createHash('sha256')
        .update(
          JSON.stringify([
            method,
            path,
            title,
            remoteDescription,
            assembled.value.parameters,
            assembled.value.bodyFields,
            assembled.value.inputSchema,
          ]),
        )
        .digest(),
    },
  };
}

/** Where the description says the service is: absolute web addresses only, without more than a path. */
function serversOf(doc: Raw, specUrl: string | undefined): string[] {
  const list = Array.isArray(doc.servers) ? doc.servers.slice(0, 10) : [];
  const found: string[] = [];
  for (const server of list) {
    if (!isRecord(server) || typeof server.url !== 'string') continue;
    const variables = isRecord(server.variables) ? server.variables : {};
    const filled = server.url.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
      const variable = variables[name];
      return isRecord(variable) && typeof variable.default === 'string' ? variable.default : whole;
    });
    try {
      const url = specUrl ? new URL(filled, specUrl) : new URL(filled);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.username || url.password || url.search || url.hash) continue;
      found.push(url.href.replace(/\/+$/, ''));
    } catch {
      // A relative address with nothing to be relative to: the person types the address.
    }
  }
  return [...new Set(found)].slice(0, 5);
}

/** How the description says the service wants to be called, when that is something tools can do. */
function authOf(ctx: ReturnType<typeof readContext>, doc: Raw): ParsedSpec['auth'] {
  const components = isRecord(doc.components) ? doc.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  const wanted: string[] = [];
  if (Array.isArray(doc.security)) {
    for (const requirement of doc.security) {
      if (isRecord(requirement)) wanted.push(...Object.keys(requirement));
    }
  }
  const names = (wanted.length > 0 ? wanted : Object.keys(schemes)).slice(0, 10);
  let unsupported: string | null = null;
  for (const name of names) {
    const found = Object.hasOwn(schemes, name) ? deref(ctx, schemes[name]) : null;
    if (!found?.ok) continue;
    const scheme = found.node;
    if (scheme.type === 'http' && String(scheme.scheme).toLowerCase() === 'bearer') {
      return { kind: 'bearer', header: 'Authorization', unsupported: null };
    }
    if (scheme.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
      if (HEADER_NAME.test(scheme.name) && credentialHeaderAllowed(scheme.name)) {
        return { kind: 'header', header: scheme.name, unsupported: null };
      }
    }
    unsupported ??=
      scheme.type === 'http'
        ? plainText(String(scheme.scheme ?? 'http'), 20)
        : scheme.type === 'apiKey'
          ? `api key in the ${plainText(String(scheme.in ?? 'request'), 10)}`
          : plainText(String(scheme.type ?? 'unknown'), 20);
  }
  return { kind: 'none', header: null, unsupported };
}

/**
 * Reads an OpenAPI 3 description given as JSON or YAML text. Throws `SpecProblem` (with words for
 * a person) when it is not one, or is too large or tangled to read.
 */
export function parseOpenApi(text: string, options: { specUrl?: string } = {}): ParsedSpec {
  const doc = readDocument(text);
  if (typeof doc.swagger === 'string') {
    throw new SpecProblem('This is a Swagger 2.0 description. Hamnivo reads OpenAPI 3.');
  }
  const openapi = doc.openapi;
  if (typeof openapi !== 'string' || !/^3\.\d+\.\d+/.test(openapi)) {
    throw new SpecProblem(
      'This does not look like an OpenAPI 3 description: it has no “openapi: 3.x.x” line.',
    );
  }
  if (!isRecord(doc.paths)) throw new SpecProblem('The description has no paths.');
  const ctx = readContext(doc);
  const info = isRecord(doc.info) ? doc.info : {};
  const operations: ParsedOperation[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const names = new Set<string>();
  let total = 0;
  try {
    for (const path of Object.keys(doc.paths)
      .filter((p) => p.startsWith('/'))
      .sort()) {
      spend(ctx);
      const resolved = deref(ctx, doc.paths[path]);
      if (!resolved.ok) {
        skipped.push({ key: path, reason: `The path could not be read (${resolved.reason}).` });
        continue;
      }
      for (const method of METHODS) {
        const operation = resolved.node[method.toLowerCase()];
        if (!isRecord(operation)) continue;
        total += 1;
        if (total > MAX_OPERATIONS) {
          throw new SpecProblem(
            `The description has more than ${MAX_OPERATIONS} operations. Remove the ones you do not need and read it again.`,
          );
        }
        const read = readOperation(ctx, method, path, resolved.node, operation, names);
        if ('skip' in read) skipped.push({ key: `${method} ${path}`, reason: read.skip });
        else operations.push(read.operation);
      }
    }
    return {
      openapi,
      title: clean(info.title, 120),
      version: clean(info.version, 40),
      hash: createHash('sha256').update(text).digest('hex'),
      servers: serversOf(doc, options.specUrl),
      auth: authOf(ctx, doc),
      operations,
      skipped,
    };
  } catch (error) {
    if (error instanceof SpecTooComplex) throw new SpecProblem(error.message);
    throw error;
  }
}
