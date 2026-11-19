

const schemaAllowsNull = (property: unknown): boolean => {
  if (property === null || typeof property !== 'object') return false
  const p = property as { type?: unknown; anyOf?: unknown[]; oneOf?: unknown[]; nullable?: unknown; enum?: unknown[] }
  if (p.nullable === true) return true
  if (p.type === 'null' || (Array.isArray(p.type) && p.type.includes('null'))) return true
  if (Array.isArray(p.enum) && p.enum.includes(null)) return true
  return [...(p.anyOf ?? []), ...(p.oneOf ?? [])].some(schemaAllowsNull)
}

type ObjectSchema = { properties?: Record<string, unknown>; required?: unknown; items?: unknown; anyOf?: unknown[]; oneOf?: unknown[]; allOf?: unknown[] }

const objectSchemaOf = (schema: unknown): ObjectSchema => {
  if (schema === null || typeof schema !== 'object') return {}
  const s = schema as ObjectSchema
  if (s.properties !== undefined) return s
  for (const branch of [...(s.anyOf ?? []), ...(s.oneOf ?? []), ...(s.allOf ?? [])]) {
    const found = objectSchemaOf(branch)
    if (found.properties !== undefined) return found
  }
  return s
}

function withoutNullOptionalsIn(value: unknown, schema: unknown): unknown {
  if (Array.isArray(value)) {
    const items = objectSchemaOf(schema).items
    let changed = false
    const out = value.map(entry => {
      const next = withoutNullOptionalsIn(entry, items)
      if (next !== entry) changed = true
      return next
    })
    return changed ? out : value
  }
  if (value === null || typeof value !== 'object') return value
  return withoutNullOptionals(value as Record<string, unknown>, schema)
}

export function withoutNullOptionals(args: Record<string, unknown>, inputSchema: unknown): Record<string, unknown> {
  const schema = objectSchemaOf(inputSchema ?? {})
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string') : [])
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key]
    if (value === null && !required.has(key) && !schemaAllowsNull(property)) {
      changed = true
      continue
    }
    const next = withoutNullOptionalsIn(value, property)
    if (next !== value) changed = true
    out[key] = next
  }
  return changed ? out : args
}
