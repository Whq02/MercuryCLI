type SchemaNode = { [key: string]: unknown }

export type StrictToolSchemaForm =
  | { strict: true; schema: SchemaNode; relaxed: string[] }
  | { strict: false; reason: string }

export const OPENAI_STRICT_TYPES = new Set(['string', 'number', 'boolean', 'integer', 'object', 'array', 'null'])

export const OPENAI_STRICT_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid'])

export const OPENAI_STRICT_UNSUPPORTED_KEYWORDS = new Set([
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$recursiveAnchor',
  '$recursiveRef',
  'additionalItems',
  'contains',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
  'else',
  'if',
  'maxContains',
  'maxProperties',
  'minContains',
  'minProperties',
  'not',
  'patternProperties',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
])

export const OPENAI_STRICT_LIMITS = {
  nestingDepth: 10,
  totalProperties: 5000,
  totalEnumValues: 1000,
  totalStringChars: 120_000,
  largeEnumValues: 250,
  largeEnumChars: 15_000,
} as const

export const OPENAI_STRICT_ANNOTATIONS = new Set(['$comment', 'default', 'description', 'examples', 'readOnly', 'title', 'writeOnly'])

const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

class StrictViolation extends Error {
  constructor(rule: string, message: string, path: string) {
    super(`${rule} ${message} at ${path === '' ? 'root' : path}`)
  }
}

function isRecord(v: unknown): v is SchemaNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

interface Budget {
  properties: number
  enumValues: number
  chars: number
}

export function strictFormAdmitsNull(node: SchemaNode): boolean {
  if (typeof node.type === 'string') return node.type === 'null'
  if (Array.isArray(node.type)) return node.type.includes('null')
  if (Array.isArray(node.anyOf)) return node.anyOf.some(arm => isRecord(arm) && strictFormAdmitsNull(arm))
  if (Array.isArray(node.enum)) return node.enum.includes(null)
  if ('const' in node) return node.const === null
  if (typeof node.$ref === 'string') return false
  return true
}

function nullable(node: SchemaNode): SchemaNode {
  if (strictFormAdmitsNull(node)) return node
  const bare = typeof node.type === 'string' && PRIMITIVE_TYPES.has(node.type) && Object.keys(node).every(key => key === 'type' || OPENAI_STRICT_ANNOTATIONS.has(key))
  if (bare) return { ...node, type: [node.type, 'null'] }
  const hoisted: SchemaNode = {}
  const inner: SchemaNode = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' || key === 'default') hoisted[key] = value
    else inner[key] = value
  }
  return { ...hoisted, anyOf: [inner, { type: 'null' }] }
}

function hasObjectShape(node: SchemaNode): boolean {
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) return true
  return isRecord(node.properties) || Array.isArray(node.required) || 'additionalProperties' in node
}

function countStrings(values: unknown[], budget: Budget): void {
  for (const value of values) if (typeof value === 'string') budget.chars += value.length
}

function convert(raw: unknown, path: string, depth: number, budget: Budget, relaxed: string[]): SchemaNode {
  if (raw === true) return {}
  if (raw === false) throw new StrictViolation('G1', 'a schema that admits no value cannot be sent strict', path)
  if (!isRecord(raw)) throw new StrictViolation('G1', 'a schema node must be an object', path)
  if (depth > OPENAI_STRICT_LIMITS.nestingDepth) throw new StrictViolation('G5', `nesting deeper than ${OPENAI_STRICT_LIMITS.nestingDepth} levels`, path)
  for (const key of Object.keys(raw)) {
    if (OPENAI_STRICT_UNSUPPORTED_KEYWORDS.has(key)) throw new StrictViolation('S1', `keyword ${key} is outside the strict subset`, path)
  }
  if (path !== '' && typeof raw.$id === 'string') throw new StrictViolation('S1', 'a nested $id is outside the strict subset', path)
  const out: SchemaNode = { ...raw }
  if (path === '') delete out.$schema
  if (Array.isArray(out.allOf)) {
    if (out.allOf.length !== 1) throw new StrictViolation('G8', 'allOf is outside the strict subset', path)
    const [branch] = out.allOf
    delete out.allOf
    if (!isRecord(branch)) throw new StrictViolation('G8', 'allOf is outside the strict subset', path)
    for (const [key, value] of Object.entries(branch)) if (!(key in out)) out[key] = value
  }
  if (Array.isArray(out.oneOf)) {
    if (Array.isArray(out.anyOf)) throw new StrictViolation('S1', 'oneOf beside anyOf cannot be rewritten', path)
    out.anyOf = out.oneOf
    delete out.oneOf
  }
  if (typeof out.$ref === 'string') {
    if (!out.$ref.startsWith('#')) throw new StrictViolation('G10', `an external $ref (${out.$ref}) is outside the strict subset`, path)
    for (const key of Object.keys(out)) {
      if (key !== '$ref' && !OPENAI_STRICT_ANNOTATIONS.has(key)) throw new StrictViolation('S1', `$ref beside ${key} is outside the strict subset`, path)
    }
    return out
  }
  if (Array.isArray(out.type) && out.type.length === 1) out.type = out.type[0]
  const types = typeof out.type === 'string' ? [out.type] : Array.isArray(out.type) ? out.type : []
  for (const t of types) {
    if (typeof t !== 'string' || !OPENAI_STRICT_TYPES.has(t)) throw new StrictViolation('G1', `type ${JSON.stringify(t)} is outside the strict subset`, path)
  }
  if (out.default === null) delete out.default
  if (typeof out.format === 'string' && !OPENAI_STRICT_FORMATS.has(out.format)) {
    relaxed.push(`format ${out.format} dropped at ${path === '' ? 'root' : path} (G9: not in the published format list)`)
    delete out.format
  }
  if (Array.isArray(out.enum)) {
    budget.enumValues += out.enum.length
    countStrings(out.enum, budget)
    if (out.enum.length > OPENAI_STRICT_LIMITS.largeEnumValues) {
      const chars = out.enum.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0)
      if (chars > OPENAI_STRICT_LIMITS.largeEnumChars) throw new StrictViolation('G7', `a ${out.enum.length}-value enum spelling ${chars} characters`, path)
    }
  }
  if ('const' in out) countStrings([out.const], budget)
  if (isRecord(out.properties)) {
    const original = new Set(Array.isArray(out.required) ? (out.required as unknown[]).filter((k): k is string => typeof k === 'string') : [])
    const props: SchemaNode = {}
    for (const [key, child] of Object.entries(out.properties)) {
      budget.properties += 1
      budget.chars += key.length
      const walked = convert(child, join(path, key), depth + 1, budget, relaxed)
      props[key] = original.has(key) ? walked : nullable(walked)
    }
    out.properties = props
    out.required = Object.keys(props)
    if (!('additionalProperties' in out)) out.additionalProperties = false
    else if (out.additionalProperties !== false) throw new StrictViolation('G4', 'an object open to extra keys (additionalProperties is not false) cannot be sent strict', path)
    if (out.type === undefined) out.type = 'object'
  } else if (hasObjectShape(out)) {
    if (out.additionalProperties !== false) throw new StrictViolation('G4', 'a free-form object (no properties, additionalProperties not false) cannot be sent strict', path)
    out.properties = {}
    out.required = []
  }
  if (Array.isArray(out.items)) throw new StrictViolation('S4', 'tuple-form items is outside the strict subset', path)
  if (out.items !== undefined) out.items = convert(out.items, join(path, 'items'), depth + 1, budget, relaxed)
  else if (types.includes('array')) throw new StrictViolation('S4', 'an array without items cannot be sent strict', path)
  if (Array.isArray(out.anyOf)) {
    out.anyOf = out.anyOf.map((arm, index) => convert(arm, join(path, `anyOf[${index}]`), depth, budget, relaxed))
  }
  for (const table of ['$defs', 'definitions'] as const) {
    if (!isRecord(out[table])) continue
    const defs: SchemaNode = {}
    for (const [name, def] of Object.entries(out[table] as SchemaNode)) {
      budget.chars += name.length
      defs[name] = convert(def, join(path, `${table}.${name}`), depth, budget, relaxed)
    }
    out[table] = defs
  }
  if (budget.properties > OPENAI_STRICT_LIMITS.totalProperties) throw new StrictViolation('G5', `more than ${OPENAI_STRICT_LIMITS.totalProperties} properties`, path)
  if (budget.enumValues > OPENAI_STRICT_LIMITS.totalEnumValues) throw new StrictViolation('G7', `more than ${OPENAI_STRICT_LIMITS.totalEnumValues} enum values`, path)
  if (budget.chars > OPENAI_STRICT_LIMITS.totalStringChars) throw new StrictViolation('G6', `names, enum and const values past ${OPENAI_STRICT_LIMITS.totalStringChars} characters`, path)
  return out
}

const memo = new WeakMap<object, StrictToolSchemaForm>()

export function toOpenaiStrictToolSchema(schema: unknown): StrictToolSchemaForm {
  if (!isRecord(schema)) return { strict: false, reason: 'G2 the root is not a schema object' }
  const seen = memo.get(schema)
  if (seen !== undefined) return seen
  let form: StrictToolSchemaForm
  try {
    const relaxed: string[] = []
    const converted = convert(schema, '', 0, { properties: 0, enumValues: 0, chars: 0 }, relaxed)
    if (Array.isArray(converted.anyOf)) throw new StrictViolation('G2', 'the root must be one object, not a union', '')
    if (converted.type !== 'object' || !isRecord(converted.properties)) throw new StrictViolation('G2', 'the root must be an object with properties', '')
    form = { strict: true, schema: converted, relaxed }
  } catch (error) {
    if (!(error instanceof StrictViolation)) throw error
    form = { strict: false, reason: error.message }
  }
  memo.set(schema, form)
  return form
}
