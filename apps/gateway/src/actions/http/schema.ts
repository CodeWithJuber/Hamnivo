import { plainText, SCHEMA_LIMITS, STRING_FORMATS } from '@hamnivo/domain/actions';

/**
 * Reading the schemas of an OpenAPI description (D10, custom HTTP tools). A description is text
 * somebody else wrote, so it is read defensively: only references inside the document are
 * followed, every step spends from a fixed budget (a description made of references to references
 * cannot grow without end), and what comes out is a plain JSON Schema that the portable subset
 * of `@hamnivo/domain/actions` still has the last word on.
 */

type Raw = Record<string, unknown>;

/** The steps a description may cost before it is refused as too large or too tangled. */
const SPEC_WORK_LIMIT = 400_000;

/** The description costs more to read than a description may. */
export class SpecTooComplex extends Error {
  override readonly name = 'SpecTooComplex';
  constructor() {
    super('The description is too large or too tangled to read.');
  }
}

export interface ReadContext {
  /** The whole document: where `#/components/…` references point. */
  doc: Raw;
  work: { left: number };
}

export const readContext = (doc: Raw): ReadContext => ({
  doc,
  work: { left: SPEC_WORK_LIMIT },
});

export function spend(ctx: ReadContext, units = 1): void {
  ctx.work.left -= units;
  if (ctx.work.left < 0) throw new SpecTooComplex();
}

export const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Found<T> = ({ ok: true } & T) | { ok: false; reason: string };

/** What `#/a/b` points to inside the document, if anything. */
function pointer(doc: Raw, fragment: string): unknown {
  let current: unknown = doc;
  for (const part of fragment.split('/').slice(1)) {
    let key: string;
    try {
      key = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    key = key.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * The object a value stands for: itself, or what its `$ref` points to, followed through further
 * references. Only references inside the document are followed. A description beside a reference
 * (OpenAPI 3.1) is kept.
 */
export function deref(ctx: ReadContext, value: unknown): Found<{ node: Raw }> {
  let current = value;
  const seen = new Set<string>();
  let description: unknown;
  while (isRecord(current) && typeof current.$ref === 'string') {
    spend(ctx);
    const ref = current.$ref;
    if (seen.has(ref) || seen.size >= 16) return { ok: false, reason: 'it refers to itself' };
    seen.add(ref);
    if (!ref.startsWith('#/')) return { ok: false, reason: 'it refers to another file' };
    if (description === undefined && typeof current.description === 'string') {
      description = current.description;
    }
    current = pointer(ctx.doc, ref.slice(1));
    if (current === undefined) return { ok: false, reason: 'a reference points nowhere' };
  }
  if (!isRecord(current)) return { ok: false, reason: 'it is not a schema' };
  return {
    ok: true,
    node: description !== undefined ? { ...current, description } : current,
  };
}

/** Two schemas that both apply, as one; null when they disagree about the type. */
function merge(a: Raw, b: Raw): Raw | null {
  const out: Raw = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (key === 'properties' && isRecord(value)) {
      out.properties = { ...(isRecord(out.properties) ? out.properties : {}), ...value };
    } else if (key === 'required' && Array.isArray(value)) {
      const before = Array.isArray(out.required) ? out.required : [];
      out.required = [...new Set([...before, ...value])];
    } else if (key === 'type' && out.type !== undefined && out.type !== value) {
      return null;
    } else if (!(key in out) || key === 'description') {
      out[key] = value;
    }
  }
  return out;
}

/** `allOf` laid flat: one schema with the properties and requirements of all of its parts. */
function flatten(ctx: ReadContext, node: Raw, depth: number): Found<{ node: Raw }> {
  if (!Array.isArray(node.allOf)) return { ok: true, node };
  if (depth > 8) return { ok: false, reason: 'it nests too deeply' };
  const { allOf, ...own } = node;
  let merged: Raw = {};
  for (const part of [...allOf, own]) {
    spend(ctx);
    const resolved = deref(ctx, part);
    if (!resolved.ok) return resolved;
    const flat = flatten(ctx, resolved.node, depth + 1);
    if (!flat.ok) return flat;
    const next = merge(merged, flat.node);
    if (!next) return { ok: false, reason: 'its parts disagree about the type' };
    merged = next;
  }
  return { ok: true, node: merged };
}

const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * `oneOf` and `anyOf` of one real shape and perhaps null become that shape, nullable; several
 * variants of one primitive type become that type. A choice between different shapes cannot be
 * a tool argument.
 */
function narrow(ctx: ReadContext, node: Raw): Found<{ node: Raw; nullable: boolean }> {
  const variants = Array.isArray(node.oneOf)
    ? node.oneOf
    : Array.isArray(node.anyOf)
      ? node.anyOf
      : null;
  if (!variants) return { ok: true, node, nullable: false };
  const { oneOf: _one, anyOf: _any, ...rest } = node;
  const kept: Raw[] = [];
  let nullable = false;
  for (const variant of variants) {
    spend(ctx);
    const resolved = deref(ctx, variant);
    if (!resolved.ok) return resolved;
    const flat = flatten(ctx, resolved.node, 0);
    if (!flat.ok) return flat;
    if (flat.node.type === 'null') nullable = true;
    else kept.push(flat.node);
  }
  const [only] = kept;
  if (kept.length === 1 && only) {
    const merged = merge(rest, only);
    return merged
      ? { ok: true, node: merged, nullable }
      : { ok: false, reason: 'its parts disagree about the type' };
  }
  const types = new Set(kept.map((variant) => variant.type));
  const [type] = [...types];
  if (kept.length > 1 && types.size === 1 && typeof type === 'string' && PRIMITIVES.has(type)) {
    const everyEnum = kept.every((variant) => Array.isArray(variant.enum));
    return {
      ok: true,
      node: {
        ...rest,
        type,
        ...(everyEnum ? { enum: [...new Set(kept.flatMap((v) => v.enum as unknown[]))] } : {}),
      },
      nullable,
    };
  }
  return { ok: false, reason: 'it allows several different shapes' };
}

/** Longest the descriptions in a tool's arguments are kept, as in the portable subset. */
const DESCRIPTION_CHARS = 500;
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const MAX_DEPTH = 4;
const MAX_NOTES = 12;

export type Converted = { ok: true; schema: Raw } | { ok: false; reason: string };

const fail = (reason: string): Converted => ({ ok: false, reason });
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function note(notes: string[], text: string) {
  if (notes.length < MAX_NOTES) notes.push(text);
}

/** The values of an enum that a tool argument can hold (short text or numbers). */
function enumOf(value: unknown): { values: (string | number)[]; nullable: boolean } | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const values: (string | number)[] = [];
  let nullable = false;
  for (const item of value) {
    if (item === null) nullable = true;
    else if (typeof item === 'string' && item.length <= 200) values.push(item);
    else if (number(item)) values.push(item);
    else return null;
  }
  return values.length > 0 ? { values, nullable } : null;
}

/**
 * One schema of a description as a plain JSON Schema the portable subset accepts: references and
 * `allOf` resolved, `nullable` and null variants as a type with `"null"`, fields that cannot be a
 * tool argument left out (said in `notes`) when they are optional, and the whole schema refused
 * when a required one is among them. `depth` is the nesting the schema starts at.
 */
export function convertSchema(
  ctx: ReadContext,
  input: unknown,
  depth: number,
  notes: string[],
  label: string,
): Converted {
  spend(ctx);
  const first = deref(ctx, input);
  if (!first.ok) return fail(first.reason);
  if (depth > MAX_DEPTH) return fail('it nests too deeply');
  const flat = flatten(ctx, first.node, 0);
  if (!flat.ok) return fail(flat.reason);
  const narrowed = narrow(ctx, flat.node);
  if (!narrowed.ok) return fail(narrowed.reason);
  const node = narrowed.node;
  let nullable = narrowed.nullable || node.nullable === true;

  let type: unknown = node.type;
  if (Array.isArray(type)) {
    const kinds = type.filter((kind) => kind !== 'null');
    if (kinds.length < type.length) nullable = true;
    if (kinds.length !== 1) return fail('it allows several types');
    type = kinds[0];
  }
  const listed = enumOf(node.enum ?? (node.const !== undefined ? [node.const] : undefined));
  if (listed?.nullable) nullable = true;
  if (type === undefined) {
    if (isRecord(node.properties)) type = 'object';
    else if (node.items !== undefined) type = 'array';
    else if (listed) type = typeof listed.values[0] === 'number' ? 'number' : 'string';
  }
  if (typeof type !== 'string' || !TYPES.has(type)) {
    return fail(type === undefined ? 'it has no type' : 'its type is not supported');
  }

  const out: Raw = { type: nullable ? [type, 'null'] : type };
  if (typeof node.description === 'string' && node.description.trim()) {
    out.description = plainText(node.description, DESCRIPTION_CHARS);
  }
  if (listed) out.enum = listed.values;

  switch (type) {
    case 'string':
      if (number(node.minLength)) out.minLength = node.minLength;
      if (number(node.maxLength)) out.maxLength = node.maxLength;
      if (
        typeof node.format === 'string' &&
        (STRING_FORMATS as readonly string[]).includes(node.format)
      ) {
        out.format = node.format;
      }
      break;
    case 'number':
    case 'integer':
      if (number(node.minimum)) out.minimum = node.minimum;
      if (number(node.maximum)) out.maximum = node.maximum;
      break;
    case 'array': {
      const items = convertSchema(ctx, node.items, depth + 1, notes, `${label}[]`);
      if (!items.ok) return fail(`its items: ${items.reason}`);
      out.items = items.schema;
      if (number(node.minItems)) out.minItems = node.minItems;
      if (number(node.maxItems)) out.maxItems = node.maxItems;
      break;
    }
    case 'object': {
      if (!isRecord(node.properties) || Object.keys(node.properties).length === 0) {
        return fail('it has no named fields');
      }
      if (Object.keys(node.properties).length > SCHEMA_LIMITS.properties) {
        return fail(`it has more than ${SCHEMA_LIMITS.properties} fields`);
      }
      const required = new Set(
        Array.isArray(node.required) ? node.required.filter((n) => typeof n === 'string') : [],
      );
      const properties: Raw = {};
      for (const name of Object.keys(node.properties).sort()) {
        const here = label ? `${label}.${name}` : name;
        const left = (reason: string): Converted | null => {
          if (required.has(name)) return fail(`${here}: ${reason}`);
          note(notes, `Left out ${here}: ${reason}.`);
          return null;
        };
        if (!NAME.test(name)) {
          const refused = left('its name has characters a tool argument cannot have');
          if (refused) return refused;
          continue;
        }
        const child = convertSchema(ctx, node.properties[name], depth + 1, notes, here);
        if (!child.ok) {
          const refused = left(child.reason);
          if (refused) return refused;
          continue;
        }
        properties[name] = child.schema;
      }
      if (Object.keys(properties).length === 0) return fail('none of its fields can be used');
      out.properties = properties;
      const kept = [...required].filter((name) => name in properties);
      if (kept.length > 0) out.required = kept;
      break;
    }
  }
  return { ok: true, schema: out };
}

/**
 * The fields of an object schema as they are written, before they are read one by one: the
 * schema's own `properties` with those of its `allOf` parts, and which are required. Null with a
 * reason when it is not an object with named fields.
 */
export function objectFields(
  ctx: ReadContext,
  input: unknown,
): Found<{ properties: Raw; required: Set<string> }> {
  spend(ctx);
  const first = deref(ctx, input);
  if (!first.ok) return first;
  const flat = flatten(ctx, first.node, 0);
  if (!flat.ok) return flat;
  const narrowed = narrow(ctx, flat.node);
  if (!narrowed.ok) return narrowed;
  const node = narrowed.node;
  if (node.type !== undefined && node.type !== 'object') {
    return { ok: false, reason: 'it is not a JSON object' };
  }
  if (!isRecord(node.properties) || Object.keys(node.properties).length === 0) {
    return { ok: false, reason: 'it has no named fields' };
  }
  const required = new Set<string>(
    Array.isArray(node.required)
      ? node.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  return { ok: true, properties: node.properties, required };
}

/** The type of a converted schema, for lists (`string`, `integer`, `array`…). */
export function typeOfConverted(schema: Raw): string {
  const type = schema.type;
  if (Array.isArray(type)) return String(type.find((kind) => kind !== 'null') ?? 'string');
  return typeof type === 'string' ? type : 'string';
}
