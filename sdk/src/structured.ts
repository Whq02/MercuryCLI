import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { JsonSchema, OutcomeRow } from './rows.js'
import { MercuryError } from './errors.js'
import { validate, type Issue } from './validate.js'

export class StructuredSchema<T> {
  constructor(readonly jsonSchema: JsonSchema, readonly decode: (value: unknown) => T) {}
}
export function structuredSchema<T>(jsonSchema: JsonSchema, decode: (value: unknown) => T): StructuredSchema<T> { return new StructuredSchema(jsonSchema, decode) }
export type OutputSchema<T = unknown> = string | JsonSchema | StructuredSchema<T>
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const kindOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)
export function schemaProblem(schema: unknown, at = 'schema'): string | undefined {
  if (!isObject(schema)) return `not a JSON schema — ${at} must be an object (found ${kindOf(schema)})`
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
  for (const type of types) if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) return `not a JSON schema — ${at}.type must be ${SCHEMA_TYPES.join(', ')} or an array of them (found ${JSON.stringify(type)})`
  for (const key of ['enum', 'required', 'oneOf', 'anyOf']) if (schema[key] !== undefined && !Array.isArray(schema[key])) return `not a JSON schema — ${at}.${key} must be an array (found ${kindOf(schema[key])})`
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (schema[key] !== undefined && typeof schema[key] !== 'number') return `not a JSON schema — ${at}.${key} must be a number (found ${kindOf(schema[key])})`
  for (const [index, name] of ((schema.required as unknown[] | undefined) ?? []).entries()) if (typeof name !== 'string') return `not a JSON schema — ${at}.required[${index}] must be a string (found ${kindOf(name)})`
  if (schema.properties !== undefined && !isObject(schema.properties)) return `not a JSON schema — ${at}.properties must be an object of schemas (found ${kindOf(schema.properties)})`
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !isObject(schema.additionalProperties)) return `not a JSON schema — ${at}.additionalProperties must be a boolean or a schema (found ${kindOf(schema.additionalProperties)})`
  for (const [key, inner] of Object.entries((schema.properties as Record<string, unknown> | undefined) ?? {})) { const problem = schemaProblem(inner, `${at}.properties.${key}`); if (problem) return problem }
  for (const key of ['items', 'propertyNames']) if (schema[key] !== undefined) { const problem = schemaProblem(schema[key], `${at}.${key}`); if (problem) return problem }
  if (isObject(schema.additionalProperties)) { const problem = schemaProblem(schema.additionalProperties, `${at}.additionalProperties`); if (problem) return problem }
  for (const key of ['oneOf', 'anyOf']) for (const [index, option] of ((schema[key] as unknown[] | undefined) ?? []).entries()) { const problem = schemaProblem(option, `${at}.${key}[${index}]`); if (problem) return problem }
  return undefined
}
export function schemaObject<T>(schema: OutputSchema<T>, cwd?: string): JsonSchema {
  const spec = schemaSource(schema, cwd)
  const problem = schemaProblem(spec)
  if (problem !== undefined) throw new MercurySchemaError([{ path: 'schema', message: problem }], null, problem)
  return spec
}
function schemaSource<T>(schema: OutputSchema<T>, cwd?: string): JsonSchema {
  if (schema instanceof StructuredSchema) return schema.jsonSchema
  if (typeof schema !== 'string') return schema
  if (schema.trim().startsWith('{')) {
    try { return JSON.parse(schema) as JsonSchema } catch (error) { throw new MercuryError('invalid schema JSON', null, { cause: error }) }
  }
  try { return JSON.parse(readFileSync(resolve(cwd ?? '.', schema), 'utf8')) as JsonSchema }
  catch (error) { throw new MercuryError('could not read schema file: ' + schema, null, { cause: error }) }
}
export class MercurySchemaError extends MercuryError {
  override readonly name = 'MercurySchemaError'
  constructor(readonly issues: readonly Issue[], readonly outcome: OutcomeRow | null, message = `structured output does not match schema: ${issues.map(issue => issue.path || 'structured').join(', ')}`) {
    super(message, null)
  }
}
export const RPC_INVALID_PARAMS = -32602
export function schemaRefusal(error: { code: number; message: string; data?: unknown }): MercurySchemaError | undefined {
  if (error.code !== RPC_INVALID_PARAMS) return undefined
  const issues = (error.data as { issues?: unknown } | undefined)?.issues
  if (!Array.isArray(issues)) return undefined
  const schema = issues.filter((issue): issue is { path: string[]; message: string } => Array.isArray(issue?.path) && issue.path[0] === 'schema' && typeof issue.message === 'string').map(issue => ({ path: issue.path.join('.'), message: issue.message }))
  if (schema.length === 0) return undefined
  const refusal = new MercurySchemaError(schema, null, schema[0]!.message)
  refusal.code = error.code
  refusal.data = error.data
  return refusal
}
export function validateOutcome<T = unknown>(outcome: OutcomeRow, schema?: OutputSchema<T>, cwd?: string): OutcomeRow<T> {
  if (schema === undefined || outcome.status !== 'completed') return outcome as OutcomeRow<T>
  const spec = schemaObject(schema, cwd)
  const issues = validate(spec, outcome.structured)
  if (issues.length) throw new MercurySchemaError(issues, outcome)
  return { ...outcome, structured: schema instanceof StructuredSchema ? schema.decode(outcome.structured) : outcome.structured as T }
}
