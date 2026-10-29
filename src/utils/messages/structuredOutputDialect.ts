
type SchemaNode = { [key: string]: unknown }

function isRecord(v: unknown): v is SchemaNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

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
  if (Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null]
  }
  return out
}

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
