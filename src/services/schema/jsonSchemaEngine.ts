
import { Ajv } from 'ajv'

export interface SchemaIssue {
  path: string
  message: string
  keyword: string
}

export type CompiledJsonSchema =
  | { ok: true; check: (value: unknown) => SchemaIssue[] }
  | { ok: false; error: string }

const compileCache = new WeakMap<object, CompiledJsonSchema>()

export function compileJsonSchema(schema: unknown): CompiledJsonSchema {
  const cacheable = typeof schema === 'object' && schema !== null
  if (cacheable) {
    const hit = compileCache.get(schema)
    if (hit) return hit
  }
  const built = build(schema)
  if (cacheable) compileCache.set(schema, built)
  return built
}

function build(schema: unknown): CompiledJsonSchema {
  try {
    const ajv = new Ajv({ allErrors: true, logger: false })
    if (!ajv.validateSchema(schema as object)) {
      return { ok: false, error: teach(ajv.errorsText(ajv.errors)) }
    }
    const validate = ajv.compile(schema as object)
    return {
      ok: true,
      check: (value: unknown): SchemaIssue[] => {
        if (validate(value)) return []
        return (validate.errors ?? []).map(e => ({
          path: e.instancePath || 'root',
          message: e.message ?? 'failed validation',
          keyword: e.keyword,
        }))
      },
    }
  } catch (e) {
    return { ok: false, error: teach(e instanceof Error ? e.message : String(e)) }
  }
}

export function formatSchemaIssues(issues: SchemaIssue[]): string {
  return issues.map(i => `${i.path}: ${i.message}`).join(', ')
}

export function issueKeywords(issues: SchemaIssue[]): string {
  return [...new Set(issues.map(i => i.keyword))].join(',') || 'unknown'
}

function teach(raw: string): string {
  if (/unknown keyword/i.test(raw)) {
    return `${raw} — remove the unknown keyword or express the constraint with standard JSON Schema draft-07 keywords (type, properties, required, items, enum, const, anyOf, oneOf, not, minimum/maximum, minLength/maxLength, pattern)`
  }
  if (/is \d+-tuple/.test(raw)) {
    return `${raw} — a fixed-position tuple needs "minItems" and "maxItems" set to the tuple length: { "items": [ … ], "minItems": N, "maxItems": N }`
  }
  return `${raw} — the schema itself was refused by the validation engine; correct the schema and retry`
}
