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
export function schemaObject<T>(schema: OutputSchema<T>, cwd?: string): JsonSchema {
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
  constructor(readonly issues: readonly Issue[], readonly outcome: OutcomeRow) {
    super(`structured output does not match schema: ${issues.map(issue => issue.path || 'structured').join(', ')}`, null)
  }
}
export function validateOutcome<T = unknown>(outcome: OutcomeRow, schema?: OutputSchema<T>, cwd?: string): OutcomeRow<T> {
  if (schema === undefined || outcome.status !== 'completed') return outcome as OutcomeRow<T>
  const spec = schemaObject(schema, cwd)
  const issues = validate(spec, outcome.structured)
  if (issues.length) throw new MercurySchemaError(issues, outcome)
  return { ...outcome, structured: schema instanceof StructuredSchema ? schema.decode(outcome.structured) : outcome.structured as T }
}
