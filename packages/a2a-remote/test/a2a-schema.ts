// Test-only validator for the pinned A2A v1.0.1 artifacts in ./fixtures (see
// fixtures/README.md). It implements exactly the JSON Schema keywords the
// upstream bundle uses and throws on any other, so a schema update cannot pass
// vacuously. protoc-gen-jsonschema omits REQUIRED and oneof, so both are read
// from the proto. No validator dependency is added.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SCHEMA_SHA256 = 'ba4b702b5edbdcbfe972c272484eb38e1fcd72af3c0b7eaa114b50e97455d8dd';
export const PROTO_SHA256 = 'e195bf96ab630c69797851970203e1b2b6b19528f2e9803b7d904b91a5104016';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const schemaBytes = read('a2a-v1.0.1.schema.json');
const protoBytes = read('a2a-v1.0.1.proto');
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const fixtureHashes = { schema: sha256(schemaBytes), proto: sha256(protoBytes) };

type Schema = Record<string, any>;
const definitions: Record<string, Schema> = JSON.parse(schemaBytes.toString('utf8')).definitions;
// Definition keys are spaced titles ("Agent Card", "O Auth2 Security Scheme").
const byName = new Map(Object.entries(definitions).map(([key, value]) => [key.replace(/ /g, ''), value]));

const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
interface ProtoMessage { required: string[]; repeatedRequired: string[]; oneofs: string[][] }
export const protoMessages = new Map<string, ProtoMessage>();
for (const [, name, body] of protoBytes.toString('utf8').matchAll(/^message (\w+) \{\n([\s\S]*?)^\}/gm)) {
  const message: ProtoMessage = { required: [], repeatedRequired: [], oneofs: [] };
  for (const [, label, , field, options] of body.matchAll(/^\s*(repeated\s+|optional\s+)?(map<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*\d+\s*(\[[^\]]*\])?;/gm)) {
    if (!options?.includes('(google.api.field_behavior) = REQUIRED')) continue;
    message.required.push(camel(field));
    if (label?.trim() === 'repeated') message.repeatedRequired.push(camel(field));
  }
  for (const [, inner] of body.matchAll(/^\s*oneof \w+ \{\n([\s\S]*?)^\s*\}/gm)) {
    message.oneofs.push([...inner.matchAll(/^\s*[\w.]+\s+(\w+)\s*=\s*\d+;/gm)].map(match => camel(match[1])));
  }
  protoMessages.set(name, message);
}
// Section 3.1.2/9.4.1 responses and Part content are one of their alternatives, not optional.
const EXACTLY_ONE = new Set(['Part', 'SendMessageResponse']);
// A final, empty page is valid and its token MUST be "" (3.1.4), which proto3's
// REQUIRED annotation cannot express.
const MAY_BE_EMPTY = new Set(['ListTasksResponse.tasks', 'ListTasksResponse.nextPageToken']);

const KEYWORDS = new Set(['$schema', 'title', 'description', 'default', 'examples', '$ref', 'type', 'properties',
  'patternProperties', 'additionalProperties', 'items', 'enum', 'anyOf', 'pattern', 'minimum', 'maximum', 'propertyNames', 'format']);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const typeOk = (value: unknown, type: string) => type === 'object' ? isObject(value) : type === 'array' ? Array.isArray(value)
  : type === 'integer' ? Number.isInteger(value) : type === 'null' ? value === null : typeof value === type;

function check(value: unknown, schema: Schema, path: string, errors: string[]) {
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw new Error(`Unsupported schema keyword ${key} at ${path}`);
  if (schema.$ref) {
    const name = /^(?:lf\.a2a\.v1|google\.protobuf)\.(\w+)\.jsonschema\.json$/.exec(schema.$ref)?.[1];
    const target = name && byName.get(name);
    if (!target) throw new Error(`Unresolved $ref ${schema.$ref}`);
    check(value, target, path, errors);
    checkProto(value, name, path, errors);
  }
  const types = schema.type === undefined ? [] : [schema.type].flat();
  if (types.length && !types.some(type => typeOk(value, type))) { errors.push(`${path}: expected ${types.join('|')}`); return; }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  // Section 5.6.1: UTC with a Z suffix, no other offsets.
  if (schema.format === 'date-time' && typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) errors.push(`${path}: not an ISO 8601 UTC timestamp`);
  if (schema.anyOf && !schema.anyOf.some((sub: Schema) => { const nested: string[] = []; check(value, sub, path, nested); return !nested.length; })) {
    errors.push(`${path}: matches no anyOf alternative`);
  }
  if (isObject(value) && (schema.properties || schema.patternProperties || schema.additionalProperties !== undefined || schema.propertyNames)) {
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames) check(key, schema.propertyNames, `${path}{${key}}`, errors);
      if (schema.properties && Object.hasOwn(schema.properties, key)) { check(item, schema.properties[key], `${path}.${key}`, errors); continue; }
      // Section 5.5: JSON output MUST be camelCase; the snake_case aliases are input leniency.
      if (Object.keys(schema.patternProperties ?? {}).some(pattern => new RegExp(pattern).test(key))) { errors.push(`${path}.${key}: snake_case alias`); continue; }
      if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected property`);
      else if (isObject(schema.additionalProperties)) check(item, schema.additionalProperties, `${path}.${key}`, errors);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`, errors));
}

function checkProto(value: unknown, name: string, path: string, errors: string[]) {
  const message = protoMessages.get(name);
  if (!message || !isObject(value)) return;
  for (const field of message.required) {
    if (value[field] === undefined || (value[field] === '' && !MAY_BE_EMPTY.has(`${name}.${field}`))) errors.push(`${path}.${field}: REQUIRED`);
  }
  // Section 5.7: arrays marked REQUIRED must contain at least one element.
  for (const field of message.repeatedRequired) {
    if (Array.isArray(value[field]) && !value[field].length && !MAY_BE_EMPTY.has(`${name}.${field}`)) errors.push(`${path}.${field}: REQUIRED array is empty`);
  }
  for (const group of message.oneofs) {
    const set = group.filter(field => value[field] !== undefined).length;
    if (set > 1 || (set === 0 && EXACTLY_ONE.has(name))) errors.push(`${path}: expected exactly one of ${group.join(', ')}`);
  }
}

/** Errors for `value` as the proto message `name` (for example 'AgentCard'). */
export function validateA2A(name: string, value: unknown): string[] {
  if (!protoMessages.has(name)) throw new Error(`Unknown proto message ${name}`);
  const errors: string[] = [];
  check(value, { $ref: `lf.a2a.v1.${name}.jsonschema.json` }, name, errors);
  return errors;
}
