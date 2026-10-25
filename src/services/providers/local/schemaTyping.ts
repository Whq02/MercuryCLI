import { inlineLocalSchemaRefs } from '../../../utils/inlineSchemaRefs.js'
import { zodToJsonSchema } from '../../../utils/zodToJsonSchema.js'

const REPAIR_DEPTH = 8

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

function declaredArms(property: Record<string, unknown>): Array<Record<string, unknown>> {
  const arms = Array.isArray(property.anyOf) ? property.anyOf : Array.isArray(property.oneOf) ? property.oneOf : []
  return arms.map(rec).filter((arm): arm is Record<string, unknown> => arm !== undefined)
}

function primaryDeclaration(property: Record<string, unknown>): { type: string | undefined; node: Record<string, unknown> } {
  if (typeof property.type === 'string') return { type: property.type, node: property }
  if (Array.isArray(property.type)) return { type: property.type.find((t): t is string => typeof t === 'string' && t !== 'null'), node: property }
  const arm = declaredArms(property).find(option => option.type !== 'null')
  if (arm !== undefined) return { type: typeof arm.type === 'string' ? arm.type : undefined, node: arm }
  return { type: undefined, node: property }
}

function admittedTypes(schema: Record<string, unknown>): string[] {
  if (typeof schema.type === 'string') return [schema.type]
  if (Array.isArray(schema.type)) return schema.type.filter((t): t is string => typeof t === 'string')
  return declaredArms(schema).flatMap(admittedTypes)
}

function jsonKinds(value: unknown): string[] {
  if (typeof value === 'string') return ['string']
  if (typeof value === 'number') return Number.isInteger(value) ? ['integer', 'number'] : ['number']
  if (typeof value === 'boolean') return ['boolean']
  if (Array.isArray(value)) return ['array']
  if (value === null) return ['null']
  return ['object']
}

function admitsAsItem(value: unknown, items: unknown): boolean {
  if (Array.isArray(items)) return false
  const schema = rec(items)
  if (schema === undefined) return true
  const admitted = admittedTypes(schema).filter(t => t !== 'null')
  if (admitted.length === 0) return true
  const kinds = jsonKinds(value)
  return admitted.some(t => kinds.includes(t))
}

export function schemaPropertyType(schema: unknown, key: string): string | undefined {
  const property = rec(rec(rec(schema)?.properties)?.[key])
  return property === undefined ? undefined : primaryDeclaration(property).type
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

function repairValue(value: unknown, property: Record<string, unknown>, depth: number): unknown {
  const { type, node } = primaryDeclaration(property)
  if (type === undefined || depth > REPAIR_DEPTH) return value
  if (type === 'array') return repairArray(value, node, depth)
  let current = value
  if (typeof current === 'string' && type !== 'string') current = typeTextBySchema(current, type)
  if (type === 'object') {
    const record = rec(current)
    if (record !== undefined) return repairObject(record, node, depth)
  }
  return current
}

function repairArray(value: unknown, node: Record<string, unknown>, depth: number): unknown {
  let current = value
  if (typeof current === 'string') {
    const parsed = parseJson(current.trim())
    if (Array.isArray(parsed)) current = parsed
    else if (parsed !== undefined && parsed !== null && admitsAsItem(parsed, node.items)) current = [parsed]
    else if (admitsAsItem(current, node.items)) current = [current]
  } else if (current !== undefined && current !== null && !Array.isArray(current) && admitsAsItem(current, node.items)) {
    current = [current]
  }
  const items = rec(node.items)
  if (!Array.isArray(current) || items === undefined) return current
  let changed = false
  const mapped = current.map(item => {
    const repaired = repairValue(item, items, depth + 1)
    if (repaired !== item) changed = true
    return repaired
  })
  return changed ? mapped : current
}

function repairObject(value: Record<string, unknown>, node: Record<string, unknown>, depth: number): Record<string, unknown> {
  const properties = rec(node.properties)
  if (properties === undefined) return value
  let out: Record<string, unknown> | undefined
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || !Object.prototype.hasOwnProperty.call(properties, key)) continue
    const property = rec(properties[key])
    if (property === undefined) continue
    const repaired = repairValue(value[key], property, depth + 1)
    if (repaired === value[key]) continue
    out ??= { ...value }
    out[key] = repaired
  }
  return out ?? value
}

export function repairArgumentsBySchema(args: Record<string, unknown>, schema: unknown): Record<string, unknown> {
  const node = rec(schema)
  return node === undefined ? args : repairObject(args, node, 0)
}

export function declaredInputSchema(tool: { inputSchema: unknown; inputJSONSchema?: unknown }): Record<string, unknown> | undefined {
  try {
    return inlineLocalSchemaRefs(rec(tool.inputJSONSchema) ?? zodToJsonSchema(tool.inputSchema as never))
  } catch {
    return undefined
  }
}
