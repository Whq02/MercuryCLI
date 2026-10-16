function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function schemaPropertyType(schema: unknown, key: string): string | undefined {
  const property = rec(rec(rec(schema)?.properties)?.[key])
  if (property === undefined) return undefined
  if (typeof property.type === 'string') return property.type
  if (Array.isArray(property.type)) return property.type.find((t): t is string => typeof t === 'string' && t !== 'null')
  if (Array.isArray(property.anyOf)) {
    const first = property.anyOf.map(rec).find(option => option !== undefined && option.type !== 'null')
    return typeof first?.type === 'string' ? first.type : undefined
  }
  return undefined
}

export function typeTextBySchema(text: string, type: string | undefined): unknown {
  const trimmed = text.trim()
  switch (type) {
    case 'string':
      return text
    case 'number':
    case 'integer': {
      const n = Number(trimmed)
      return trimmed !== '' && Number.isFinite(n) ? n : text
    }
    case 'boolean':
      return trimmed === 'true' ? true : trimmed === 'false' ? false : text
    case 'object': {
      const parsed = rec(parseJson(trimmed))
      return parsed === undefined ? text : parsed
    }
    case 'array': {
      const parsed = parseJson(trimmed)
      return Array.isArray(parsed) ? parsed : text
    }
    default: {
      if (/^(?:\{|\[|-?\d|true$|false$|null$)/.test(trimmed)) {
        const parsed = parseJson(trimmed)
        if (parsed !== undefined) return parsed
      }
      return text
    }
  }
}

export function typeStringArgumentsBySchema(args: Record<string, unknown>, schema: unknown): Record<string, unknown> {
  let out: Record<string, unknown> | undefined
  for (const key of Object.keys(args)) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const type = schemaPropertyType(schema, key)
    if (type === undefined || type === 'string') continue
    const typed = typeTextBySchema(value, type)
    if (typed === value) continue
    out ??= { ...args }
    out[key] = typed
  }
  return out ?? args
}
