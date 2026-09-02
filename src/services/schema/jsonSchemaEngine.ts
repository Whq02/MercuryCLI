// ============================================================================
//  services/schema/jsonSchemaEngine — THE one JSON-Schema validation engine.
//
//  Spec 03 C1's law: the workflow validator is the single engine ("shared
//  module — never a second validator"), and spec 01 C2 routes the eval
//  bridge's agent()/completion() schema checks through the same law. Both
//  consumers (WorkflowTool/structuredOutputTool and services/eval/evalBridge)
//  import THIS module; a second `new Ajv(` anywhere under src/ is a law
//  break, pinned by scripts/eval/prove-schema-conformance.ts.
//
//  Semantics are exactly the workflow validator's founding config — Ajv
//  draft-07, `{ allErrors: true }`, default strict posture — so every
//  consumer judges "does this JSON match this schema?" identically. Two
//  verdict surfaces:
//    · a schema that the engine itself refuses (meta-schema violation,
//      strict-mode compile throw such as an unknown keyword) comes back as
//      `{ ok: false, error }` where the error TEACHES the correction — the
//      retired permissive-lite validator silently tolerated these shapes,
//      and that flip must never be silent;
//    · a compiled schema yields exact per-path issues (path · message ·
//      the Ajv keyword that fired, which is the telemetry-safe rule name).
//
//  Ajv's advisory strict-mode compile logs are silenced (logger: false):
//  they change no verdict, and the TUI owns the terminal — a validator must
//  never scribble on the alternate screen.
// ============================================================================

import { Ajv } from 'ajv'

export interface SchemaIssue {
  /** Ajv instancePath, `'root'` at the top — the workflow detail spelling. */
  path: string
  message: string
  /** The validation keyword that fired (rule name only — telemetry-safe). */
  keyword: string
}

export type CompiledJsonSchema =
  | { ok: true; check: (value: unknown) => SchemaIssue[] }
  | { ok: false; error: string }

// Callers pass the SAME schema object reference across many calls per run
// (workflow scripts especially); Ajv compilation would otherwise dominate.
// Identity-cached — successes AND refusals — with weak keying so the cache
// never retains a schema. Boolean schemas (valid JSON Schema: `true`/`false`)
// cannot key a WeakMap and compile trivially, so they skip the cache.
const compileCache = new WeakMap<object, CompiledJsonSchema>()

/**
 * Compile `schema` under the one engine. `{ ok: false }` means the SCHEMA
 * itself was refused — the error text names the refusal and teaches the
 * correction, ready to show a model.
 */
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

/** One issue line per failing path, the workflow's spelling — enough for the
 *  model to correct and retry. */
export function formatSchemaIssues(issues: SchemaIssue[]): string {
  return issues.map(i => `${i.path}: ${i.message}`).join(', ')
}

/** The distinct rule names that fired — what telemetry may see (instance
 *  data and paths are user-owned and stay out). */
export function issueKeywords(issues: SchemaIssue[]): string {
  return [...new Set(issues.map(i => i.keyword))].join(',') || 'unknown'
}

/** A schema refusal must TEACH: the permissive-lite validator this engine
 *  replaced tolerated these shapes, so the model that wrote one gets the
 *  correction, never a bare rejection. */
function teach(raw: string): string {
  if (/unknown keyword/i.test(raw)) {
    return `${raw} — remove the unknown keyword or express the constraint with standard JSON Schema draft-07 keywords (type, properties, required, items, enum, const, anyOf, oneOf, not, minimum/maximum, minLength/maxLength, pattern)`
  }
  if (/is \d+-tuple/.test(raw)) {
    return `${raw} — a fixed-position tuple needs "minItems" and "maxItems" set to the tuple length: { "items": [ … ], "minItems": N, "maxItems": N }`
  }
  return `${raw} — the schema itself was refused by the validation engine; correct the schema and retry`
}
