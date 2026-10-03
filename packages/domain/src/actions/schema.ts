/**
 * The portable JSON Schema subset that tool inputs and outputs are described in (G07). Schemas
 * from MCP servers are untrusted: they are reduced to this subset before anything uses them, so a
 * server cannot smuggle a slow regular expression, a remote `$ref`, a huge enum or an unbounded
 * nesting into Hamnivo. Validation is deterministic, needs no dependency and normalizes strings to
 * NFC, so the canonical form of validated arguments (and its hash) is stable.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PortableType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export const STRING_FORMATS = ['email', 'uri', 'date', 'date-time', 'uuid'] as const;
export type StringFormat = (typeof STRING_FORMATS)[number];

export interface PortableSchema {
  type: PortableType;
  /** `type: [T, "null"]` in JSON Schema. */
  nullable?: boolean;
  description?: string;
  enum?: (string | number)[];
  minLength?: number;
  maxLength?: number;
  format?: StringFormat;
  /** Only kept from trusted (built-in) definitions. */
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: PortableSchema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, PortableSchema>;
  required?: string[];
}

/** Ceilings that hold whatever a schema says. */
export const SCHEMA_LIMITS = {
  depth: 4,
  properties: 40,
  enumValues: 100,
  enumValueLength: 200,
  descriptionLength: 500,
  patternLength: 200,
  stringLength: 10_000,
  arrayItems: 200,
} as const;

const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const TYPES = new Set<PortableType>(['string', 'number', 'integer', 'boolean', 'array', 'object']);

export type SchemaResult =
  | { ok: true; schema: PortableSchema }
  | { ok: false; problem: string; path: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;

/**
 * Control characters other than tab and line breaks, and the bidirectional embedding, override
 * and isolate characters that can make text read differently from what it is ("Trojan Source").
 */
function invisible(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return false;
  return (
    codePoint < 0x20 ||
    codePoint === 0x7f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/** Text safe to show and to hand to a model: no control or direction-override characters. */
export function plainText(value: string, max: number): string {
  let out = '';
  for (const char of value.normalize('NFC')) {
    if (!invisible(char.codePointAt(0) ?? 0)) out += char;
  }
  return out.trim().slice(0, max);
}

function sanitizeNode(raw: unknown, path: string, depth: number, trusted: boolean): SchemaResult {
  const fail = (problem: string, at = path): SchemaResult => ({ ok: false, problem, path: at });
  if (!isRecord(raw)) return fail('A schema must be an object.');
  if (depth > SCHEMA_LIMITS.depth) return fail('The schema nests too deeply.');
  if ('$ref' in raw || 'anyOf' in raw || 'oneOf' in raw || 'allOf' in raw || 'not' in raw) {
    return fail('References and combined schemas are not supported.');
  }
  let type: unknown = raw.type;
  let nullable = false;
  if (Array.isArray(type)) {
    const kinds = type.filter((t) => t !== 'null');
    nullable = kinds.length < type.length;
    if (kinds.length !== 1) return fail('Only one type (optionally with null) is supported.');
    type = kinds[0];
  }
  if (typeof type !== 'string' || !TYPES.has(type as PortableType)) {
    return fail('Unsupported or missing type.');
  }
  const schema: PortableSchema = { type: type as PortableType };
  if (nullable) schema.nullable = true;
  if (typeof raw.description === 'string' && raw.description.trim()) {
    schema.description = plainText(raw.description, SCHEMA_LIMITS.descriptionLength);
  }
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0) return fail('An enum must list values.');
    if (raw.enum.length > SCHEMA_LIMITS.enumValues) return fail('The enum is too long.');
    const values: (string | number)[] = [];
    for (const value of raw.enum) {
      if (typeof value === 'string' && value.length <= SCHEMA_LIMITS.enumValueLength) {
        values.push(value.normalize('NFC'));
      } else if (finite(value)) {
        values.push(value);
      } else {
        return fail('Enum values must be short strings or numbers.');
      }
    }
    schema.enum = values;
  }
  switch (schema.type) {
    case 'string': {
      if (count(raw.minLength)) schema.minLength = raw.minLength;
      schema.maxLength = count(raw.maxLength)
        ? Math.min(raw.maxLength, SCHEMA_LIMITS.stringLength)
        : SCHEMA_LIMITS.stringLength;
      if (
        typeof raw.format === 'string' &&
        (STRING_FORMATS as readonly string[]).includes(raw.format)
      ) {
        schema.format = raw.format as StringFormat;
      }
      if (trusted && typeof raw.pattern === 'string') {
        if (raw.pattern.length > SCHEMA_LIMITS.patternLength)
          return fail('The pattern is too long.');
        try {
          new RegExp(raw.pattern, 'u');
        } catch {
          return fail('The pattern is not a valid regular expression.');
        }
        schema.pattern = raw.pattern;
      }
      break;
    }
    case 'number':
    case 'integer':
      if (finite(raw.minimum)) schema.minimum = raw.minimum;
      if (finite(raw.maximum)) schema.maximum = raw.maximum;
      break;
    case 'boolean':
      break;
    case 'array': {
      if (raw.items === undefined) return fail('An array needs an items schema.');
      const items = sanitizeNode(raw.items, `${path}/items`, depth + 1, trusted);
      if (!items.ok) return items;
      schema.items = items.schema;
      if (count(raw.minItems)) schema.minItems = raw.minItems;
      schema.maxItems = count(raw.maxItems)
        ? Math.min(raw.maxItems, SCHEMA_LIMITS.arrayItems)
        : SCHEMA_LIMITS.arrayItems;
      break;
    }
    case 'object': {
      const properties = raw.properties === undefined ? {} : raw.properties;
      if (!isRecord(properties)) return fail('Properties must be an object.');
      const names = Object.keys(properties);
      if (names.length > SCHEMA_LIMITS.properties) return fail('Too many properties.');
      schema.properties = {};
      for (const name of names.sort()) {
        if (!PROPERTY_NAME.test(name)) return fail('Unsupported property name.', `${path}/${name}`);
        const child = sanitizeNode(properties[name], `${path}/${name}`, depth + 1, trusted);
        if (!child.ok) return child;
        schema.properties[name] = child.schema;
      }
      if (raw.required !== undefined) {
        if (!Array.isArray(raw.required)) return fail('Required must list property names.');
        const required = [...new Set(raw.required)].filter(
          (name): name is string => typeof name === 'string' && name in (schema.properties ?? {}),
        );
        if (required.length) schema.required = required.sort();
      }
      break;
    }
  }
  return { ok: true, schema };
}

/**
 * Reduces a JSON Schema to the portable subset. The root must be an object schema (tool
 * arguments are named). Untrusted schemas lose `pattern`; unknown keywords are dropped; anything
 * that cannot be represented safely is refused with the path of the problem.
 */
export function sanitizeToolSchema(raw: unknown, options: { trusted: boolean }): SchemaResult {
  const result = sanitizeNode(raw ?? { type: 'object' }, '', 0, options.trusted);
  if (result.ok && result.schema.type !== 'object') {
    return { ok: false, problem: 'Tool arguments must be an object.', path: '' };
  }
  return result;
}

/** The subset as standard JSON Schema (draft 2020-12 compatible), for model providers. */
export function toJsonSchema(schema: PortableSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: schema.nullable ? [schema.type, 'null'] : schema.type,
  };
  for (const key of [
    'description',
    'enum',
    'minLength',
    'maxLength',
    'format',
    'pattern',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
    'required',
  ] as const) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [name, toJsonSchema(child)]),
    );
    out.additionalProperties = false;
  }
  return out;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: JsonValue }
  | { ok: false; issues: ValidationIssue[] };

const FORMATS: Record<StringFormat, RegExp> = {
  email: /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/,
  uri: /^[a-z][a-z0-9+.-]{1,20}:[^\s]{1,2000}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

function validateNode(
  schema: PortableSchema,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): JsonValue | undefined {
  const issue = (message: string) => {
    if (issues.length < 20) issues.push({ path: path || '/', message });
    return undefined;
  };
  if (value === null) return schema.nullable ? null : issue('A value is required.');
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    return issue(`Must be one of: ${schema.enum.slice(0, 10).join(', ')}.`);
  }
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return issue('Must be text.');
      const text = value.normalize('NFC');
      const length = [...text].length;
      if (schema.minLength !== undefined && length < schema.minLength) return issue('Too short.');
      if (length > (schema.maxLength ?? SCHEMA_LIMITS.stringLength)) return issue('Too long.');
      if (schema.format && !FORMATS[schema.format].test(text)) {
        return issue(`Must be a valid ${schema.format}.`);
      }
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(text)) {
        return issue('Does not have the expected form.');
      }
      return text;
    }
    case 'number':
    case 'integer': {
      if (!finite(value)) return issue('Must be a number.');
      if (schema.type === 'integer' && !Number.isInteger(value))
        return issue('Must be a whole number.');
      if (schema.minimum !== undefined && value < schema.minimum) return issue('Too small.');
      if (schema.maximum !== undefined && value > schema.maximum) return issue('Too large.');
      return value;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : issue('Must be true or false.');
    case 'array': {
      if (!Array.isArray(value)) return issue('Must be a list.');
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return issue('Too few items.');
      }
      if (value.length > (schema.maxItems ?? SCHEMA_LIMITS.arrayItems))
        return issue('Too many items.');
      const items = schema.items;
      if (!items) return issue('The schema has no items.');
      const out: JsonValue[] = [];
      value.forEach((item, index) => {
        const checked = validateNode(items, item, `${path}/${index}`, issues);
        if (checked !== undefined) out.push(checked);
      });
      return out;
    }
    case 'object': {
      if (!isRecord(value)) return issue('Must be an object.');
      const properties = schema.properties ?? {};
      const out: Record<string, JsonValue> = {};
      for (const name of Object.keys(value)) {
        if (!(name in properties)) issue(`Unknown field "${name.slice(0, 64)}".`);
      }
      for (const name of schema.required ?? []) {
        if (value[name] === undefined) {
          if (issues.length < 20) issues.push({ path: `${path}/${name}`, message: 'Required.' });
        }
      }
      for (const [name, child] of Object.entries(properties)) {
        if (value[name] === undefined) continue;
        const checked = validateNode(child, value[name], `${path}/${name}`, issues);
        if (checked !== undefined) out[name] = checked;
      }
      return out;
    }
  }
}

/**
 * Validates tool arguments (or output) against a portable schema. Unknown fields are refused, not
 * dropped: the arguments an approver sees are exactly the ones that run.
 */
export function validateAgainstSchema(schema: PortableSchema, value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const checked = validateNode(schema, value, '', issues);
  if (issues.length > 0 || checked === undefined) {
    return { ok: false, issues: issues.length ? issues : [{ path: '/', message: 'Invalid.' }] };
  }
  return { ok: true, value: checked };
}
