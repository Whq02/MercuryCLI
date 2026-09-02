// ============================================================================
//  utils/messages/structuredOutputDialect — the vendor-dialect law for
//  structured-output schemas, one owner for both halves of it.
//
//  Mercury consumers declare JsonOutputFormat in plain JSON Schema: an
//  optional property is simply absent from `required`. The OpenAI Responses
//  text.format validator enforces a stricter dialect — every object level
//  must carry additionalProperties:false and a `required` array naming EVERY
//  key under `properties`; optionality is spelled as a nullable type union
//  instead. A lax schema is refused at the wire (http 400
//  `invalid_json_schema`, "'required' is required to be supplied and to
//  include every key in `properties`") before any model runs — the live
//  HARDENING sighting: Minerva's chat leg on gpt-5.6-luna never reached the
//  model at all.
//
//  toOpenaiStrictSchema is the request-side transform, called at the ONE
//  bridge site that puts a schema on the OpenAI wire (responsesBridge).
//  Consumers keep writing plain JSON Schema; the vendor spelling is the
//  bridge's problem, exactly like the message and tool mapping beside it.
//  The transform is idempotent: a lawful schema passes through with its
//  required set unchanged, so no field turns nullable twice.
//
//  stripExplicitNulls is the answer-side half of the SAME law: under the
//  strict dialect the model MUST emit every key, so optional-and-absent
//  comes back as an explicit null. Dropping null-valued OBJECT KEYS restores
//  the absent-means-absent contract every validator was written against.
//  Array elements are never dropped — a null row is a real row, and the
//  validator refuses it honestly.
// ============================================================================

type SchemaNode = { [key: string]: unknown }

function isRecord(v: unknown): v is SchemaNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Make one property schema accept null beside what it already accepts.
 *  Guarded for idempotence: a node already admitting null is unchanged. */
function nullable(node: unknown): unknown {
  if (!isRecord(node)) return node
  const out: SchemaNode = { ...node }
  const t = out.type
  if (typeof t === 'string') {
    if (t !== 'null') out.type = [t, 'null']
  } else if (Array.isArray(t)) {
    if (!t.includes('null')) out.type = [...t, 'null']
  } else if (Array.isArray(out.anyOf)) {
    const arms = out.anyOf as unknown[]
    const hasNull = arms.some(a => isRecord(a) && a.type === 'null')
    if (!hasNull) out.anyOf = [...arms, { type: 'null' }]
  }
  // An enum is exhaustive over VALUES — a nullable enum must admit the null
  // value itself, not just the null type.
  if (Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null]
  }
  return out
}

/**
 * The OpenAI strict-dialect spelling of a plain JSON schema: every object
 * level closed (additionalProperties:false), `required` naming every key,
 * originally-optional keys made nullable. Pure; the input is never mutated.
 */
export function toOpenaiStrictSchema(schema: SchemaNode): SchemaNode {
  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(walk)
    if (!isRecord(node)) return node
    const out: SchemaNode = { ...node }
    if (isRecord(out.properties)) {
      const original = new Set(Array.isArray(out.required) ? (out.required as string[]) : [])
      const props: SchemaNode = {}
      for (const [key, child] of Object.entries(out.properties)) {
        const walked = walk(child)
        props[key] = original.has(key) ? walked : nullable(walked)
      }
      out.properties = props
      out.required = Object.keys(props)
      out.additionalProperties = false
    }
    if (out.items !== undefined) out.items = walk(out.items)
    for (const comb of ['anyOf', 'oneOf', 'allOf'] as const) {
      if (Array.isArray(out[comb])) out[comb] = (out[comb] as unknown[]).map(walk)
    }
    for (const defs of ['$defs', 'definitions'] as const) {
      if (isRecord(out[defs])) {
        const mapped: SchemaNode = {}
        for (const [k, v] of Object.entries(out[defs] as SchemaNode)) mapped[k] = walk(v)
        out[defs] = mapped
      }
    }
    return out
  }
  return walk(schema) as SchemaNode
}

/**
 * Drop null-valued keys from decoded structured answers, recursively —
 * the strict dialect forces the model to spell absence as null; validators
 * keep their absent-means-absent contract. Array elements are preserved
 * (nulls inside arrays stay, and the validator speaks to them).
 */
export function stripExplicitNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripExplicitNulls)
  if (!isRecord(value)) return value
  const out: SchemaNode = {}
  for (const [key, v] of Object.entries(value)) {
    if (v === null) continue
    out[key] = stripExplicitNulls(v)
  }
  return out
}
