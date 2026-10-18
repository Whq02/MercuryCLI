import type { CallModelRoute } from '../services/providers/idSpaces.js'

type SchemaNode = Record<string, unknown>

type SchemaLane = 'anthropic-strict' | 'llama-grammar' | 'ref-default' | 'responses'

type RenameTree = { keys: Record<string, string>; children: Record<string, RenameTree> }

export const PROPERTY_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/

const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

const memo = new WeakMap<object, Map<SchemaLane, { schema: SchemaNode; renamed: RenameTree | null }>>()
const renamedByTool = new Map<string, RenameTree>()

function isRecord(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function schemaLaneFor(route: CallModelRoute | null): SchemaLane | null {
  switch (route) {
    case 'anthropic':
      return 'anthropic-strict'
    case 'local':
      return 'llama-grammar'
    case 'openai-compat':
    case 'openrouter':
    case 'together':
      return 'ref-default'
    case 'openai':
      return 'responses'
    default:
      return null
  }
}

export function legalPropertyKey(key: string, taken: Set<string>): string {
  if (PROPERTY_KEY_PATTERN.test(key) && !taken.has(key)) return key
  const base = (key.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) || 'key').slice(0, 64)
  let candidate = base
  for (let n = 2; taken.has(candidate) || candidate === ''; n++) {
    const suffix = `_${n}`
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`
  }
  return candidate
}

function bareSchema(value: unknown): SchemaNode | unknown {
  if (value === true) return {}
  if (typeof value === 'string') return JSON_TYPES.has(value) ? { type: value } : {}
  return value
}

function splitTypeArray(node: SchemaNode): SchemaNode {
  const types = node.type
  if (!Array.isArray(types)) return node
  const distinct = [...new Set(types.filter((item): item is string => typeof item === 'string'))]
  if (distinct.length === 0) return node
  if (distinct.length === 1) return { ...node, type: distinct[0] }
  const { type: _type, ...rest } = node
  return { anyOf: distinct.map(item => ({ ...rest, type: item })) }
}

function walkLane(lane: SchemaLane, node: unknown, tree: RenameTree | null, depth: number): unknown {
  if (depth > 64) return node
  const bare = bareSchema(node)
  if (!isRecord(bare)) return bare
  let out: SchemaNode = bare
  if (lane === 'llama-grammar') {
    out = splitTypeArray(out)
    if (out.type === 'object' && !isRecord(out.properties)) out = { ...out, properties: {} }
  }
  if (lane === 'ref-default' && typeof out.$ref === 'string' && 'default' in out) {
    const { default: _default, ...rest } = out
    out = rest
  }
  if (isRecord(out.properties)) {
    const properties: SchemaNode = {}
    const taken = new Set<string>()
    const renames: Record<string, string> = {}
    let moved = false
    for (const [key, child] of Object.entries(out.properties)) {
      const wire = lane === 'anthropic-strict' ? legalPropertyKey(key, taken) : key
      taken.add(wire)
      if (wire !== key) renames[wire] = key
      const childTree: RenameTree | null = tree === null ? null : { keys: {}, children: {} }
      const walked = walkLane(lane, child, childTree, depth + 1)
      if (wire !== key || walked !== child) moved = true
      properties[wire] = walked
      if (tree !== null && childTree !== null && (Object.keys(childTree.keys).length > 0 || Object.keys(childTree.children).length > 0)) tree.children[key] = childTree
    }
    if (tree !== null) Object.assign(tree.keys, renames)
    if (moved) {
      const required = Array.isArray(out.required) && Object.keys(renames).length > 0
        ? out.required.map(name => Object.entries(renames).find(([, original]) => original === name)?.[0] ?? name)
        : out.required
      out = { ...out, properties, ...(required !== undefined ? { required } : {}) }
    }
  }
  for (const key of ['items', 'additionalProperties'] as const) {
    if (isRecord(out[key]) || out[key] === true || typeof out[key] === 'string') {
      const childTree: RenameTree | null = tree === null ? null : { keys: {}, children: {} }
      const walked = walkLane(lane, out[key], childTree, depth + 1)
      if (walked !== out[key]) out = { ...out, [key]: walked }
      if (tree !== null && childTree !== null && (Object.keys(childTree.keys).length > 0 || Object.keys(childTree.children).length > 0)) tree.children[key === 'items' ? '*' : '**'] = childTree
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = out[key]
    if (Array.isArray(branches)) {
      const walked = branches.map(child => walkLane(lane, child, tree, depth + 1))
      if (walked.some((child, index) => child !== branches[index])) out = { ...out, [key]: walked }
    }
  }
  return out
}

function objectBranches(node: SchemaNode): SchemaNode[] | null {
  const branches = (node.anyOf ?? node.oneOf) as unknown
  if (!Array.isArray(branches)) return null
  const kept = branches.filter((branch): branch is SchemaNode => isRecord(branch) && branch.type !== 'null')
  return kept.length > 0 && kept.every(branch => branch.type === 'object' || isRecord(branch.properties)) ? kept : null
}

function rootForLane(lane: SchemaLane, node: SchemaNode): SchemaNode {
  if (lane !== 'anthropic-strict' && lane !== 'responses') return node
  const branches = objectBranches(node)
  if (branches === null) return node
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = node
  if (branches.length === 1) return { ...rest, ...branches[0] }
  const properties: SchemaNode = {}
  for (const branch of branches) if (isRecord(branch.properties)) for (const [key, child] of Object.entries(branch.properties)) if (!(key in properties)) properties[key] = child
  return { ...rest, type: 'object', properties }
}

function parsedCopy(schema: SchemaNode, serialized: string | undefined): SchemaNode {
  if (serialized === undefined) return schema
  try {
    const parsed: unknown = JSON.parse(serialized)
    return isRecord(parsed) ? parsed : schema
  } catch {
    return schema
  }
}

export function normalizeToolSchemaFor(lane: SchemaLane | null, schema: SchemaNode, serialized?: string): { schema: SchemaNode; renamed: RenameTree | null } {
  if (lane === null || !isRecord(schema)) return { schema, renamed: null }
  const seen = memo.get(schema)?.get(lane)
  if (seen !== undefined) return seen
  const source = parsedCopy(schema, serialized)
  const tree: RenameTree = { keys: {}, children: {} }
  const walked = walkLane(lane, rootForLane(lane, source), lane === 'anthropic-strict' ? tree : null, 0)
  const renamed = Object.keys(tree.keys).length > 0 || Object.keys(tree.children).length > 0 ? tree : null
  const result = { schema: isRecord(walked) && walked !== source ? walked : schema, renamed }
  let byLane = memo.get(schema)
  if (byLane === undefined) {
    byLane = new Map()
    memo.set(schema, byLane)
  }
  byLane.set(lane, result)
  return result
}

export function rememberRenamedArgumentKeys(toolName: string, renamed: RenameTree | null): void {
  if (renamed === null) renamedByTool.delete(toolName)
  else renamedByTool.set(toolName, renamed)
}

function restoreWith(tree: RenameTree, value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = tree.children['*']
    return items === undefined ? value : value.map(item => restoreWith(items, item))
  }
  if (!isRecord(value)) return value
  const out: SchemaNode = {}
  for (const [wire, child] of Object.entries(value)) {
    const original = tree.keys[wire] ?? wire
    const below = tree.children[original] ?? tree.children['**']
    out[original] = below === undefined ? child : restoreWith(below, child)
  }
  return out
}

export function restoreRenamedArgumentKeys<T extends Record<string, unknown>>(toolName: string, args: T): T {
  const tree = renamedByTool.get(toolName)
  if (tree === undefined) return args
  return restoreWith(tree, args) as T
}

export function _renamedToolsForTesting(): string[] {
  return [...renamedByTool.keys()]
}
