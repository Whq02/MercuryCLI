type SchemaNode = Record<string, unknown>

const SCHEMA_TABLES = new Set(['properties', 'patternProperties', 'dependentSchemas'])
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
const SCHEMA_SINGLES = new Set(['items', 'additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'])
const DEFINITION_TABLES = new Set(['$defs', 'definitions'])
const NESTING_LIMIT = 32
const RESOLUTION_BUDGET = 4000

const flattened = new WeakMap<object, SchemaNode>()

function isRecord(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLocalRef(node: SchemaNode): node is SchemaNode & { $ref: string } {
  return typeof node.$ref === 'string' && node.$ref.startsWith('#')
}

function pointerTarget(root: SchemaNode, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    let part: string
    try {
      part = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    part = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(node)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return undefined
      node = node[index]
    } else if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, part)) {
      node = node[part]
    } else {
      return undefined
    }
  }
  return node
}

function mapSubschemas(node: SchemaNode, map: (child: unknown) => unknown, definitions: 'keep' | 'drop'): SchemaNode {
  const out: SchemaNode = {}
  for (const [key, value] of Object.entries(node)) {
    if (DEFINITION_TABLES.has(key)) {
      if (definitions === 'keep') out[key] = value
    } else if (SCHEMA_TABLES.has(key) && isRecord(value)) {
      const table: SchemaNode = {}
      for (const [name, child] of Object.entries(value)) table[name] = map(child)
      out[key] = table
    } else if ((SCHEMA_LISTS.has(key) || key === 'items') && Array.isArray(value)) {
      out[key] = value.map(map)
    } else if (SCHEMA_SINGLES.has(key)) {
      out[key] = map(value)
    } else {
      out[key] = value
    }
  }
  return out
}

function hasLocalRef(node: unknown): boolean {
  if (!isRecord(node)) return false
  if (isLocalRef(node)) return true
  let found = false
  mapSubschemas(node, child => {
    if (!found && hasLocalRef(child)) found = true
    return child
  }, 'drop')
  return found
}

function withoutDefinitions(node: unknown): unknown {
  return isRecord(node) ? mapSubschemas(node, withoutDefinitions, 'drop') : node
}

function flatten(root: SchemaNode): SchemaNode {
  if (!hasLocalRef(root)) return root
  let unresolved = false
  let budget = RESOLUTION_BUDGET
  const walk = (node: unknown, stack: readonly string[]): unknown => {
    if (!isRecord(node)) return node
    if (!isLocalRef(node)) return mapSubschemas(node, child => walk(child, stack), 'keep')
    const target = pointerTarget(root, node.$ref)
    if (target === undefined || stack.includes(node.$ref) || stack.length >= NESTING_LIMIT || budget <= 0) {
      unresolved = true
      return node
    }
    budget--
    const resolved = walk(target, [...stack, node.$ref])
    const { $ref: _pointer, ...siblings } = node
    const rest = mapSubschemas(siblings, child => walk(child, stack), 'keep')
    if (isRecord(resolved)) return { ...resolved, ...rest }
    if (resolved === false) return { ...rest, not: {} }
    return rest
  }
  const out = walk(root, [])
  if (!isRecord(out)) return root
  return unresolved ? out : (withoutDefinitions(out) as SchemaNode)
}

export function inlineLocalSchemaRefs<T extends SchemaNode>(schema: T, serialized?: string): T {
  if (!isRecord(schema)) return schema
  const memo = flattened.get(schema)
  if (memo !== undefined) return memo as T
  const out = serialized !== undefined && !serialized.includes('"$ref"') ? schema : flatten(schema)
  flattened.set(schema, out)
  return out as T
}
