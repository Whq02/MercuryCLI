#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'tool-forms-census-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail.length > 600 ? `${detail.slice(0, 600)}…` : detail}` : ''}`)
  if (!ok) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — tool forms census exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { getAllBaseTools } = await import('../../src/tools.ts')
const { declaredInputSchema } = await import('../../src/services/providers/local/schemaTyping.ts')
const { normalizeToolSchemaFor } = await import('../../src/utils/normalizeToolSchema.ts')
const { mapToolsToOpenai } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { stripNullArgs } = await import('../../src/services/providers/openai/openaiWire.ts')
const { gateToolCall } = await import('../../src/services/providers/toolCallGate.ts')
const { toOpenaiStrictSchema, stripExplicitNulls } = await import('../../src/utils/messages/structuredOutputDialect.ts')
type ToolDialect = typeof import('../../src/utils/messages/toolSchemaDialect.ts')
const dialect: Partial<ToolDialect> = await import('../../src/utils/messages/toolSchemaDialect.ts').catch(() => ({}))
const toOpenaiStrictToolSchema: ToolDialect['toOpenaiStrictToolSchema'] = dialect.toOpenaiStrictToolSchema ?? (() => ({ strict: false, reason: 'the tool dialect module is absent on this tree' }))
const strictFormAdmitsNull: ToolDialect['strictFormAdmitsNull'] = dialect.strictFormAdmitsNull ?? (() => false)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')

type Node = Record<string, unknown>
type AnyTool = {
  name: string
  inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }
  inputJSONSchema?: Node
  validateInput?: (input: unknown, context: unknown) => Promise<{ result: boolean; message?: string }> | { result: boolean; message?: string }
  call?: unknown
}
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)

const WORK = join(SCRATCH, 'work')
mkdirSync(WORK, { recursive: true })
const PLAIN = join(WORK, 'plain.md')
writeFileSync(PLAIN, '# plain\n\nbody line\n')
bootstrap.setCwdState(WORK)

const roster = new Map<string, AnyTool>()
for (const tool of getAllBaseTools()) roster.set(tool.name, tool as unknown as AnyTool)
const catalogued = roster.size
const toolsSource = readFileSync(join(import.meta.dir, '../../src/tools.ts'), 'utf8')
for (const match of toolsSource.matchAll(/import \{([^}]+)\} from '(\.\/tools\/[^']+)'/g)) {
  const mod = (await import(join(import.meta.dir, '../../src', match[2]!.slice(2)))) as Record<string, unknown>
  for (const name of match[1]!.split(',').map(s => s.trim()).filter(Boolean)) {
    const exported = mod[name]
    for (const candidate of Array.isArray(exported) ? exported : [exported]) {
      const tool = candidate as AnyTool | undefined
      if (tool && typeof tool.name === 'string' && tool.inputSchema !== undefined && typeof tool.call === 'function' && !roster.has(tool.name)) roster.set(tool.name, tool)
    }
  }
}

const fixtures: Array<{ name: string; schema: Node; expect: 'strict' | 'non-strict'; why: string }> = [
  {
    name: 'mcp__fx__nested',
    expect: 'strict',
    why: 'nested optionals in an object and in array items, $defs/$ref, enum, const, default',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'required' },
        kind: { type: 'string', const: 'note' },
        tags: { type: 'array', items: { type: 'string' } },
        owner: { $ref: '#/$defs/person' },
        reviewers: { type: 'array', items: { $ref: '#/$defs/person' } },
        priority: { type: 'string', enum: ['low', 'high'], default: 'low' },
      },
      required: ['title', 'kind'],
      $defs: {
        person: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string', enum: ['lead', 'member'] } }, required: ['name'] },
      },
    },
  },
  {
    name: 'mcp__fx__union_root',
    expect: 'strict',
    why: 'a root oneOf of two objects collapses to one object on the responses lane before the dialect',
    schema: {
      oneOf: [
        { type: 'object', properties: { op: { type: 'string', const: 'start' }, name: { type: 'string' } }, required: ['op', 'name'] },
        { type: 'object', properties: { op: { type: 'string', const: 'stop' }, name: { type: 'string' }, force: { type: 'boolean' } }, required: ['op', 'name'] },
      ],
    },
  },
  { name: 'mcp__fx__allof', expect: 'non-strict', why: 'allOf with two arms (G8)', schema: { type: 'object', allOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'string' } } }] } },
  { name: 'mcp__fx__freeform', expect: 'non-strict', why: 'an object with no properties (G4)', schema: { type: 'object' } },
  { name: 'mcp__fx__open', expect: 'non-strict', why: 'additionalProperties: true beside properties (G4)', schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true } },
  { name: 'mcp__fx__record', expect: 'non-strict', why: 'a map with typed values, additionalProperties as a schema (G4)', schema: { type: 'object', properties: { env: { type: 'object', additionalProperties: { type: 'string' } } } } },
  { name: 'mcp__fx__formats', expect: 'strict', why: 'format uri relaxed, format email kept (G9)', schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, mail: { type: 'string', format: 'email' } }, required: ['url'] } },
  { name: 'mcp__fx__tuple', expect: 'non-strict', why: 'tuple-form items (S4)', schema: { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } } },
  { name: 'mcp__fx__noargs', expect: 'strict', why: 'no parameters: a closed empty object', schema: { type: 'object', properties: {} } },
  {
    name: 'mcp__fx__recursive',
    expect: 'strict',
    why: 'a recursive definition reached through an optional $ref',
    schema: { type: 'object', properties: { tree: { $ref: '#/$defs/node' } }, required: ['tree'], $defs: { node: { type: 'object', properties: { value: { type: 'number' }, next: { $ref: '#/$defs/node' } }, required: ['value'] } } },
  },
  {
    name: 'mcp__fx__deep',
    expect: 'non-strict',
    why: 'twelve levels of nesting (G5)',
    schema: (() => {
      let node: Node = { type: 'string' }
      for (let level = 0; level < 12; level++) node = { type: 'object', properties: { inner: node }, required: ['inner'] }
      return node
    })(),
  },
]
for (const fixture of fixtures) {
  roster.set(fixture.name, { name: fixture.name, inputSchema: z.looseObject({}), inputJSONSchema: fixture.schema, call: () => undefined })
}

section(`§1 the roster: ${catalogued} tools in the scratch catalogue, ${roster.size - catalogued - fixtures.length} more reached through their modules, ${fixtures.length} MCP-shaped fixtures`)
t('the catalogue is the real one (more than 40 tools)', catalogued > 40, String(catalogued))
for (const core of ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'ChangeSet', 'WebFetch', 'Crewmate', 'AskUserQuestion']) t(`roster carries ${core}`, roster.has(core))

const PUBLISHED_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid'])
const PUBLISHED_TYPES = new Set(['string', 'number', 'boolean', 'integer', 'object', 'array', 'null'])
const ALLOWED_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'const',
  'description', 'title', 'default', 'examples', '$comment', 'readOnly', 'writeOnly',
  '$defs', 'definitions', '$ref',
  'pattern', 'format', 'minLength', 'maxLength',
  'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum',
  'minItems', 'maxItems',
])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', '$comment', 'readOnly', 'writeOnly'])

function validateStrictSubset(root: unknown): string[] {
  const out: string[] = []
  if (!isNode(root)) return ['G2 the root is not an object schema']
  if (root.type !== 'object') out.push('G2 the root must have type object')
  if (root.anyOf !== undefined) out.push('G2 the root must not be anyOf')
  if (!isNode(root.properties)) out.push('G2 the root must declare properties')
  const totals = { properties: 0, enumValues: 0, chars: 0 }
  const resolve = (ref: string): unknown => {
    if (ref === '#') return root
    let node: unknown = root
    for (const part of ref.replace(/^#\//, '').split('/')) node = isNode(node) ? node[part] : undefined
    return node
  }
  const walk = (node: unknown, path: string, depth: number): void => {
    const at = path === '' ? 'root' : path
    if (!isNode(node)) {
      out.push(`G1 a schema node must be an object at ${at}`)
      return
    }
    if (depth > 10) out.push(`G5 nesting past 10 levels at ${at}`)
    for (const key of Object.keys(node)) {
      if (ALLOWED_KEYS.has(key)) continue
      if (path === '' && (key === '$schema' || key === '$id')) continue
      out.push(`S1/G8 keyword ${key} is outside the published subset at ${at}`)
    }
    if (typeof node.$ref === 'string') {
      if (!node.$ref.startsWith('#')) out.push(`G10 external $ref at ${at}`)
      else if (resolve(node.$ref) === undefined) out.push(`G10 unresolved $ref ${node.$ref} at ${at}`)
      for (const key of Object.keys(node)) if (key !== '$ref' && !ANNOTATIONS.has(key)) out.push(`S1 $ref beside ${key} at ${at}`)
      return
    }
    const types = typeof node.type === 'string' ? [node.type] : Array.isArray(node.type) ? node.type : []
    for (const ty of types) if (typeof ty !== 'string' || !PUBLISHED_TYPES.has(ty)) out.push(`G1 type ${JSON.stringify(ty)} at ${at}`)
    if (typeof node.format === 'string' && !PUBLISHED_FORMATS.has(node.format)) out.push(`G9 format ${node.format} at ${at}`)
    if (node.default === null) out.push(`S5 a null default at ${at}`)
    if (Array.isArray(node.enum)) {
      totals.enumValues += node.enum.length
      for (const value of node.enum) if (typeof value === 'string') totals.chars += value.length
    }
    if (typeof node.const === 'string') totals.chars += node.const.length
    const objectTyped = types.includes('object')
    if (isNode(node.properties)) {
      if (node.additionalProperties !== false) out.push(`G4 additionalProperties must be false at ${at}`)
      const keys = Object.keys(node.properties)
      const required = Array.isArray(node.required) ? (node.required as unknown[]) : null
      if (required === null || required.length !== keys.length || !keys.every(key => required.includes(key))) out.push(`G3/F1 required must name every property at ${at}`)
      for (const key of keys) {
        totals.properties += 1
        totals.chars += key.length
        walk(node.properties[key], path === '' ? key : `${path}.${key}`, depth + 1)
      }
    } else if (objectTyped || node.required !== undefined || node.additionalProperties !== undefined) {
      out.push(`G4 an object without properties cannot be strict at ${at}`)
    }
    if (Array.isArray(node.items)) out.push(`S4 tuple-form items at ${at}`)
    else if (node.items !== undefined) walk(node.items, `${path}[]`, depth + 1)
    else if (types.includes('array')) out.push(`S4 an array without items at ${at}`)
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((arm, index) => walk(arm, `${path}|${index}`, depth))
    for (const table of ['$defs', 'definitions']) {
      if (!isNode(node[table])) continue
      for (const [name, def] of Object.entries(node[table] as Node)) {
        totals.chars += name.length
        walk(def, `${path}${path === '' ? '' : '.'}${table}.${name}`, depth)
      }
    }
  }
  walk(root, '', 0)
  if (totals.properties > 5000) out.push(`G5 ${totals.properties} properties`)
  if (totals.enumValues > 1000) out.push(`G7 ${totals.enumValues} enum values`)
  if (totals.chars > 120_000) out.push(`G6 ${totals.chars} characters of names and values`)
  return out
}

type Slot = { required: boolean; admitsNull: boolean }
function admitsNullOriginal(node: unknown): boolean {
  if (!isNode(node)) return false
  if (typeof node.type === 'string') return node.type === 'null'
  if (Array.isArray(node.type)) return node.type.includes('null')
  const arms = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null
  if (arms !== null) return arms.some(admitsNullOriginal)
  if (Array.isArray(node.enum)) return node.enum.includes(null)
  if ('const' in node) return node.const === null
  if (typeof node.$ref === 'string') return false
  return true
}
function nullWrapOf(node: Node): Node | undefined {
  const arms = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null
  if (arms !== null && arms.length === 2 && isNode(arms[0]) && JSON.stringify(arms[1]) === '{"type":"null"}') return arms[0]
  return undefined
}
function collectSlots(root: unknown, strict: boolean): Map<string, Slot> {
  const slots = new Map<string, Slot>()
  const walk = (node: unknown, path: string, depth: number): void => {
    if (!isNode(node) || depth > 12) return
    if (typeof node.$ref === 'string') return
    const inner = nullWrapOf(node)
    if (inner !== undefined) {
      walk(inner, path, depth)
      return
    }
    if (isNode(node.properties)) {
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
      for (const [key, child] of Object.entries(node.properties)) {
        const here = path === '' ? key : `${path}.${key}`
        slots.set(here, { required: required.has(key), admitsNull: strict ? (isNode(child) && strictFormAdmitsNull(child)) : admitsNullOriginal(child) })
        walk(child, here, depth + 1)
      }
    }
    if (isNode(node.items)) walk(node.items, `${path}[]`, depth + 1)
    const arms = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : []
    arms.forEach((arm, index) => walk(arm, `${path}|${index}`, depth))
    for (const table of ['$defs', 'definitions']) {
      if (!isNode(node[table])) continue
      for (const [name, def] of Object.entries(node[table] as Node)) walk(def, `${path}${path === '' ? '' : '.'}${table}.${name}`, depth)
    }
  }
  walk(root, '', 0)
  return slots
}

const sampleFile = (key: string): string => (/(file|notebook)?_?path$/i.test(key) || key === 'filePath' ? PLAIN : key === 'url' ? 'https://example.com/' : key === 'command' ? 'true' : key === 'cwd' ? WORK : 'x')
type Mode = 'nulls' | 'blanks' | 'plain'
function typesOf(node: Node): string[] {
  if (typeof node.type === 'string') return [node.type]
  if (Array.isArray(node.type)) return node.type.filter((v): v is string => typeof v === 'string' && v !== 'null')
  if (Array.isArray(node.enum)) return ['enum']
  if ('const' in node) return ['const']
  return []
}
function sampleValue(node: unknown, key: string, mode: Mode, root: Node, depth: number): unknown {
  if (!isNode(node) || depth > 10) return 'x'
  if (typeof node.$ref === 'string') {
    let target: unknown = root
    if (node.$ref !== '#') for (const part of node.$ref.replace(/^#\//, '').split('/')) target = isNode(target) ? target[part] : undefined
    return depth > 6 ? 'x' : sampleValue(target, key, mode, root, depth + 1)
  }
  if ('const' in node) return node.const
  if (Array.isArray(node.enum)) return node.enum.find(v => v !== null) ?? 'x'
  const arms = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null
  if (arms !== null && !typesOf(node).length) {
    const arm = arms.find(a => isNode(a) && a.type !== 'null') ?? arms[0]
    return sampleValue(arm, key, mode, root, depth + 1)
  }
  const ty = typesOf(node)[0]
  switch (ty) {
    case 'string': {
      if (typeof node.minLength === 'number' && node.minLength > 1) return 'x'.repeat(node.minLength)
      if (typeof node.pattern === 'string') return 'x'
      return sampleFile(key)
    }
    case 'integer':
    case 'number': {
      if (typeof node.exclusiveMinimum === 'number') return node.exclusiveMinimum + 1
      if (typeof node.minimum === 'number' && node.minimum > 0) return node.minimum
      return 1
    }
    case 'boolean':
      return true
    case 'array': {
      const min = typeof node.minItems === 'number' ? node.minItems : 0
      const count = Math.max(min, 1)
      const items = node.items
      return min === 0 && !isNode(items) ? [] : Array.from({ length: count }, () => (isNode(items) && isNode(items.properties) ? buildForm(items, mode, root, depth + 1) : sampleValue(items, key, mode, root, depth + 1)))
    }
    case 'object':
      return isNode(node.properties) ? buildForm(node, mode, root, depth + 1) : {}
    default:
      return 'x'
  }
}
function placeholderFor(node: unknown): { has: true; value: unknown } | { has: false } {
  if (!isNode(node)) return { has: false }
  const types = typesOf(node)
  if (types.includes('string') && !('const' in node) && !Array.isArray(node.enum)) return { has: true, value: '' }
  if (types.includes('boolean')) return { has: true, value: false }
  if (types.includes('array')) {
    const items = isNode(node.items) ? node.items : undefined
    const fixed = typeof node.minItems === 'number' && node.minItems === node.maxItems && node.minItems > 0
    if (fixed && items && (items.type === 'integer' || items.type === 'number')) return { has: true, value: Array.from({ length: node.minItems as number }, () => 0) }
    return { has: true, value: [] }
  }
  return { has: false }
}
function buildForm(node: Node, mode: Mode, root: Node, depth = 0): Node {
  const out: Node = {}
  if (!isNode(node.properties)) return out
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
  for (const [key, child] of Object.entries(node.properties)) {
    if (required.has(key)) {
      out[key] = sampleValue(child, key, mode, root, depth + 1)
      continue
    }
    if (mode === 'nulls') out[key] = null
    else if (mode === 'blanks') {
      const placeholder = placeholderFor(child)
      if (placeholder.has) out[key] = placeholder.value
    }
  }
  return out
}
function originalFor(tool: AnyTool): Node {
  const declared = declaredInputSchema(tool as never) as Node | undefined
  if (declared === undefined) throw new Error(`${tool.name}: no declared schema`)
  return tool.inputJSONSchema !== undefined ? normalizeToolSchemaFor('responses', declared).schema : declared
}
function expectedAfterStrip(value: unknown, node: unknown, root: Node, depth = 0): unknown {
  if (depth > 12 || !isNode(node)) return value
  if (typeof node.$ref === 'string') {
    let target: unknown = root
    if (node.$ref !== '#') for (const part of node.$ref.replace(/^#\//, '').split('/')) target = isNode(target) ? target[part] : undefined
    return expectedAfterStrip(value, target, root, depth + 1)
  }
  if (Array.isArray(value)) return isNode(node.items) ? value.map(item => expectedAfterStrip(item, node.items, root, depth + 1)) : value
  if (!isNode(value)) return value
  let shape: Node | undefined = isNode(node.properties) ? node : undefined
  if (shape === undefined) {
    const arms = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : []
    shape = arms.find((arm): arm is Node => isNode(arm) && isNode(arm.properties))
  }
  if (shape === undefined) return value
  const required = new Set(Array.isArray(shape.required) ? (shape.required as string[]) : [])
  const out: Node = {}
  for (const [key, v] of Object.entries(value)) {
    if (v === null && !required.has(key)) continue
    out[key] = expectedAfterStrip(v, (shape.properties as Node)[key], root, depth + 1)
  }
  return out
}
function hasNullAt(value: unknown, path: string[]): boolean {
  let node: unknown = value
  for (const part of path) {
    if (part === '[]') node = Array.isArray(node) ? node[0] : undefined
    else node = isNode(node) ? node[part] : undefined
  }
  return node === null
}

const EXPECTED_NON_STRICT: Record<string, RegExp> = {
  Crewmate: /propertyNames/, AskUserQuestion: /propertyNames/, Service: /propertyNames/, Git: /propertyNames/, Journey: /propertyNames/,
  Godot: /propertyNames/, Unity: /propertyNames/, Blender: /propertyNames/, Aseprite: /propertyNames/, JevEval: /additionalProperties/,
  StructuredOutput: /additionalProperties/, TaskCreate: /propertyNames/, TaskUpdate: /propertyNames/,
}
const MUST_BE_STRICT = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'ChangeSet', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Skill', 'ToolSearch', 'Monitor', 'Sleep']

function makeContext(): unknown {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    messages: [],
    options: { commands: [], tools: [], mainLoopModel: 'fixture', debug: false, verbose: false, isNonInteractiveSession: true, agents: [] },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    setAppState: () => {},
  }
}

type Verdict = { ok: true } | { ok: false; message: string }
async function validateWith(tool: AnyTool, input: Node): Promise<Verdict> {
  if (typeof tool.validateInput !== 'function') return { ok: true }
  try {
    const verdict = await tool.validateInput(input, makeContext())
    return verdict && verdict.result === false ? { ok: false, message: String(verdict.message ?? 'refused') } : { ok: true }
  } catch (error) {
    return { ok: false, message: `threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
function gateWith(tool: AnyTool, input: Node): Verdict {
  const verdict = gateToolCall([tool] as never, { id: 'census', name: tool.name, argumentsRaw: JSON.stringify(input), malformed: false })
  return verdict.ok ? { ok: true } : { ok: false, message: verdict.refusal.reason }
}

type Row = { tool: string; strict: string; why: string; blanks: string }
const rows: Row[] = []
const censusFailures: string[] = []

section('§2 translate out: every tool, strict where the published subset allows, non-strict with a reason where it does not')
const wireByTool = new Map<string, Node>()
for (const [name, tool] of roster) {
  let original: Node
  try {
    original = originalFor(tool)
  } catch (error) {
    t(`${name}: a declared schema exists`, false, String(error))
    continue
  }
  const [wire] = mapToolsToOpenai([{ name, input_schema: original }]) as unknown as Node[]
  wireByTool.set(name, wire!)
  const form = toOpenaiStrictToolSchema(original)
  const fixture = fixtures.find(f => f.name === name)
  if (wire!.strict === true) {
    const violations = validateStrictSubset(wire!.parameters)
    if (violations.length > 0) censusFailures.push(`${name}: strict form breaks the subset: ${violations.join('; ')}`)
    const relaxed = form.strict ? form.relaxed : []
    rows.push({ tool: name, strict: 'strict', why: relaxed.length > 0 ? relaxed.join('; ') : fixture?.why ?? 'converts within the published subset', blanks: '' })
    if (fixture && fixture.expect !== 'strict') censusFailures.push(`${name}: expected non-strict (${fixture.why}) but was sent strict`)
    if (name in EXPECTED_NON_STRICT) censusFailures.push(`${name}: expected non-strict but was sent strict`)
  } else {
    const reason = form.strict ? '(no reason)' : form.reason
    if (wire!.strict !== false) censusFailures.push(`${name}: the wire carries no strict flag at all`)
    if (wire!.parameters !== original) censusFailures.push(`${name}: a non-strict tool must carry its parameters as written`)
    rows.push({ tool: name, strict: 'non-strict', why: reason, blanks: '' })
    if (fixture && fixture.expect !== 'non-strict') censusFailures.push(`${name}: expected strict (${fixture.why}) but fell back: ${reason}`)
    if (!fixture && !(name in EXPECTED_NON_STRICT)) censusFailures.push(`${name}: fell back to non-strict without being a known free-form tool: ${reason}`)
    if (name in EXPECTED_NON_STRICT && !EXPECTED_NON_STRICT[name]!.test(reason)) censusFailures.push(`${name}: non-strict for an unexpected reason: ${reason}`)
    if (!/^(G\d+|S\d+|F\d+)\b/.test(reason)) censusFailures.push(`${name}: the reason names no rule: ${reason}`)
  }
}
for (const name of MUST_BE_STRICT) t(`${name} is sent strict`, wireByTool.get(name)?.strict === true, JSON.stringify(wireByTool.get(name)?.strict))
t('every strict form is valid under the published subset and every non-strict tool has a rule-named reason', censusFailures.length === 0, censusFailures.join(' | '))
t('a tool whose schema is not an object is sent non-strict, never dropped and never a throw', (() => {
  const [wire] = mapToolsToOpenai([{ name: 'odd', input_schema: {} }]) as unknown as Node[]
  return wire!.strict === false && isNode(wire!.parameters) && wire!.name === 'odd'
})())
t('one bad schema never sinks its neighbours: a free-form tool beside Read leaves Read strict', (() => {
  const read = originalFor(roster.get('Read')!)
  const wires = mapToolsToOpenai([{ name: 'mcp__fx__freeform', input_schema: { type: 'object' } }, { name: 'Read', input_schema: read }]) as unknown as Node[]
  return wires[0]!.strict === false && wires[1]!.strict === true
})())
{
  const read = wireByTool.get('Read')!.parameters as Node
  const props = read.properties as Node
  t('Read strict form: every key required, closed object', JSON.stringify(read.required) === JSON.stringify(Object.keys(props)) && read.additionalProperties === false, JSON.stringify(read.required))
  t('Read strict form: file_path stays a plain required string', JSON.stringify(props.file_path) === JSON.stringify({ type: 'string', description: 'Absolute path of the file to open' }), JSON.stringify(props.file_path))
  t('Read strict form: pages is "string or null" and keeps its description', isNode(props.pages) && JSON.stringify(props.pages.type) === '["string","null"]' && typeof props.pages.description === 'string', JSON.stringify(props.pages))
  t('Read strict form: crop is "the four-integer box or null" (the vendor anyOf spelling for a constrained type)', isNode(props.crop) && Array.isArray(props.crop.anyOf) && JSON.stringify((props.crop.anyOf as Node[])[1]) === '{"type":"null"}' && (props.crop.anyOf as Node[])[0]!.minItems === 4, JSON.stringify(props.crop))
  t('Read strict form: the description keeps the plain meaning (no vendor words added)', typeof props.crop === 'object' && String((props.crop as Node).description).startsWith('For an image: a box [x1, y1, x2, y2]'))
  const changeSet = wireByTool.get('ChangeSet')!.parameters as Node
  const unwrap = (node: Node): Node => (Array.isArray(node.anyOf) ? (node.anyOf as Node[])[0]! : node)
  const changes = unwrap((changeSet.properties as Node).changes as Node)
  const hunk = unwrap(((changes.items as Node).properties as Node).hunks as Node)
  const insert = ((hunk.items as Node).properties as Node).insert as Node
  t('ChangeSet strict form: the nested optional enum hunks[].insert is "before|after or null"', Array.isArray(insert.anyOf) && JSON.stringify((insert.anyOf as Node[])[0]!.enum) === '["before","after"]' && JSON.stringify((insert.anyOf as Node[])[1]) === '{"type":"null"}', JSON.stringify(insert))
  const fx = wireByTool.get('mcp__fx__nested')!.parameters as Node
  const owner = (fx.properties as Node).owner as Node
  const person = Array.isArray(owner.anyOf) ? ((owner.anyOf as Node[])[0] as Node) : {}
  t('fixture: an optional object (the inlined $ref) becomes "the closed object or null", its own optional role a nullable enum and name required', JSON.stringify((owner.anyOf as Node[])?.[1]) === '{"type":"null"}' && JSON.stringify(person.required) === '["name","role"]' && person.additionalProperties === false && JSON.stringify(((person.properties as Node).role as Node).anyOf) === JSON.stringify([{ type: 'string', enum: ['lead', 'member'] }, { type: 'null' }]), JSON.stringify(owner))
  const kind = (fx.properties as Node).kind as Node
  t('fixture: a required const stays a const', kind.const === 'note' && kind.type === 'string')
  const priority = (fx.properties as Node).priority as Node
  t('fixture: a non-null default is kept and hoisted beside the nullable union', priority.default === 'low' && Array.isArray(priority.anyOf), JSON.stringify(priority))
  const recursive = wireByTool.get('mcp__fx__recursive')!.parameters as Node
  const next = ((((recursive.$defs as Node).node as Node).properties as Node).next as Node)
  t('fixture: a recursive $ref survives inlining and its optional slot becomes "the reference or null" (the vendor\'s linked-list spelling)', JSON.stringify(next.anyOf) === JSON.stringify([{ $ref: '#/$defs/node' }, { type: 'null' }]) && JSON.stringify(((recursive.$defs as Node).node as Node).required) === '["value","next"]', JSON.stringify(recursive))
  const formats = wireByTool.get('mcp__fx__formats')!.parameters as Node
  t('fixture: format uri is relaxed away and format email kept', ((formats.properties as Node).url as Node).format === undefined && JSON.stringify(((formats.properties as Node).mail as Node).anyOf) === JSON.stringify([{ type: 'string', format: 'email' }, { type: 'null' }]), JSON.stringify(formats.properties))
  const unionRoot = wireByTool.get('mcp__fx__union_root')!.parameters as Node
  t('fixture: the root union collapses to one closed object on the responses lane', unionRoot.type === 'object' && unionRoot.anyOf === undefined && JSON.stringify(unionRoot.required) === '["op","name","force"]', JSON.stringify(unionRoot))
  const bash = wireByTool.get('Bash')!.parameters as Node
  t('Bash strict form drops the root $schema pointer the model never reads', !('$schema' in bash))
  const original = originalFor(roster.get('Read')!)
  mapToolsToOpenai([{ name: 'Read', input_schema: original }])
  t('the converter never mutates the tool\'s own schema (Read still has one required key)', JSON.stringify(original.required) === '["file_path"]' && !JSON.stringify((original.properties as Node).pages).includes('null'))
}

section('§3 the strict form keeps every optional answerable with null and every required one required')
{
  const slotFailures: string[] = []
  let optionalSlots = 0
  let requiredSlots = 0
  for (const [name, tool] of roster) {
    const wire = wireByTool.get(name)
    if (!wire || wire.strict !== true) continue
    const original = originalFor(tool)
    const before = collectSlots(toOpenaiStrictToolSchema(original).strict ? original : original, false)
    const after = collectSlots(wire.parameters, true)
    const originalHadOneOf = JSON.stringify(original).includes('"oneOf"')
    for (const [path, slot] of before) {
      const strictSlot = after.get(path)
      if (strictSlot === undefined) {
        if (!originalHadOneOf) slotFailures.push(`${name}: slot ${path} missing from the strict form`)
        continue
      }
      if (!strictSlot.required) slotFailures.push(`${name}: ${path} is not required in the strict form`)
      if (slot.required) {
        requiredSlots++
        if (!slot.admitsNull && strictSlot.admitsNull) slotFailures.push(`${name}: required ${path} was widened to admit null`)
      } else {
        optionalSlots++
        if (!strictSlot.admitsNull) slotFailures.push(`${name}: optional ${path} cannot be answered with null`)
      }
    }
  }
  t(`every optional slot admits null and every required slot stays as declared (${optionalSlots} optional, ${requiredSlots} required slots across the strict roster)`, slotFailures.length === 0 && optionalSlots > 100, slotFailures.slice(0, 12).join(' | '))
}

section('§4 translate back: null in every optional slot comes back as the omitted form; a required null stays for its own check')
{
  const roundTripFailures: string[] = []
  let nestedOptionalNulls = 0
  for (const [name, tool] of roster) {
    const original = originalFor(tool)
    const nulls = buildForm(original, 'nulls', original)
    const expected = expectedAfterStrip(nulls, original, original)
    const stripped = stripNullArgs(nulls, original)
    if (JSON.stringify(stripped) !== JSON.stringify(expected)) roundTripFailures.push(`${name}: ${JSON.stringify(stripped).slice(0, 200)} ≠ ${JSON.stringify(expected).slice(0, 200)}`)
    const nestedNullPaths = [...collectSlots(original, false)].filter(([path, slot]) => !slot.required && path.includes('.')).map(([path]) => path)
    nestedOptionalNulls += nestedNullPaths.length
    if (JSON.stringify(stripped).includes(':null') && !JSON.stringify(expected).includes(':null')) roundTripFailures.push(`${name}: a null survived that the schema calls optional`)
  }
  t(`the nulls form of every tool strips to its omitted form (${nestedOptionalNulls} nested optional slots covered)`, roundTripFailures.length === 0, roundTripFailures.slice(0, 8).join(' | '))

  const changeSet = roster.get('ChangeSet')!
  const original = originalFor(changeSet)
  const call = { op: 'apply', plan_id: null, changes: [{ file_path: PLAIN, expected_anchor: 'fa:0000000000', hunks: [{ lines: '1', replace: 'x', insert: null }] }] }
  const stripped = stripNullArgs(call, original) as Node
  const hunk = (((stripped.changes as Node[])[0]!.hunks as Node[])[0]!) as Node
  t('ChangeSet: hunks[].insert: null (an optional enum, nested two arrays deep) is removed; the required fields stay', !('insert' in hunk) && hunk.lines === '1' && hunk.replace === 'x' && !('plan_id' in stripped), JSON.stringify(stripped))
  const gated = gateWith(changeSet, call)
  t('ChangeSet: the gate admits the call (on the base the nested null reached zod and was refused)', gated.ok, gated.ok ? '' : gated.message)

  const read = roster.get('Read')!
  const readOriginal = originalFor(read)
  const strictAnswer = { file_path: PLAIN, offset: null, limit: null, ranges: null, pages: null, crop: null, outline: null, line_anchors: null }
  t('Read: a strict-dialect answer with null in every unused box strips to {file_path}', JSON.stringify(stripNullArgs(strictAnswer, readOriginal)) === JSON.stringify({ file_path: PLAIN }))
  t('Read: a null in the required file_path slot stays and the schema refuses it (the required check, not a silent drop)', (() => {
    const kept = stripNullArgs({ file_path: null, limit: null }, readOriginal) as Node
    return kept.file_path === null && !('limit' in kept) && read.inputSchema.safeParse(kept).success === false
  })())
  t('a null inside a free-form object is payload and stays', (() => {
    const schema = { type: 'object', properties: { doc: { type: 'object' } }, required: ['doc'] }
    const out = stripNullArgs({ doc: { a: null, b: 1 } }, schema) as Node
    return JSON.stringify(out) === JSON.stringify({ doc: { a: null, b: 1 } })
  })())
  t('a null element of an array is never dropped', JSON.stringify(stripNullArgs({ xs: [null, { a: null }] }, { type: 'object', properties: { xs: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } } } })) === JSON.stringify({ xs: [null, {}] }))
  t('a required nullable slot keeps its null (payload)', JSON.stringify(stripNullArgs({ v: null }, { type: 'object', properties: { v: { type: ['string', 'null'] } }, required: ['v'] })) === JSON.stringify({ v: null }))
  t('a union: optional in one arm and required in another — the null goes (the required arm refuses absence just the same)', JSON.stringify(stripNullArgs({ op: 'a', plan: null }, { type: 'object', properties: { op: { type: 'string' } }, anyOf: [{ properties: { plan: { type: 'string' } } }, { properties: { plan: { type: 'string' } }, required: ['plan'] }] })) === JSON.stringify({ op: 'a' }))
  t('without a schema the old top-level law holds (back-compat for schema-less callers)', JSON.stringify(stripNullArgs({ a: null, b: { c: null } })) === JSON.stringify({ b: { c: null } }))
  t('the fixture union root: a null for the optional force field goes through the collapsed root', JSON.stringify(stripNullArgs({ op: 'stop', name: 'svc', force: null }, originalFor(roster.get('mcp__fx__union_root')!))) === JSON.stringify({ op: 'stop', name: 'svc' }))
}

section('§5 the all-blanks form: Astra\'s placeholders in every optional box on a plain valid target, through the gate and validateInput')
{
  const defects: string[] = []
  for (const [name, tool] of roster) {
    const row = rows.find(r => r.tool === name)!
    if (name === 'StructuredOutput') {
      row.blanks = 'never offered to a model'
      continue
    }
    const original = originalFor(tool)
    const plain = buildForm(original, 'plain', original)
    const blanks = buildForm(original, 'blanks', original)
    const blankKeys = Object.keys(blanks).filter(key => !(key in plain))
    if (blankKeys.length === 0 && JSON.stringify(plain) === JSON.stringify(blanks)) {
      row.blanks = 'no blank-able optional'
      continue
    }
    const plainGate = gateWith(tool, plain)
    const blanksGate = gateWith(tool, blanks)
    if (plainGate.ok && !blanksGate.ok) {
      const culprit = blankKeys.find(key => {
        const without = { ...blanks }
        delete without[key]
        return gateWith(tool, without).ok
      })
      defects.push(`${name}: the gate refused the all-blanks form (${culprit ?? 'nested blank'}): ${blanksGate.message}`)
      row.blanks = `DEFECT at the gate (${culprit ?? 'nested blank'})`
      continue
    }
    if (!plainGate.ok) {
      row.blanks = `same as plain (gate: ${plainGate.message.split('\n')[0]!.slice(0, 80)})`
      continue
    }
    const parsedPlain = gateToolCall([tool] as never, { id: 'p', name, argumentsRaw: JSON.stringify(plain), malformed: false })
    const parsedBlanks = gateToolCall([tool] as never, { id: 'b', name, argumentsRaw: JSON.stringify(blanks), malformed: false })
    const plainValid = parsedPlain.ok ? await validateWith(tool, parsedPlain.input) : { ok: false as const, message: 'gate' }
    const blanksValid = parsedBlanks.ok ? await validateWith(tool, parsedBlanks.input) : { ok: false as const, message: 'gate' }
    if (plainValid.ok && !blanksValid.ok) {
      let culprit: string | undefined
      for (const key of blankKeys) {
        const without = { ...blanks }
        delete without[key]
        const gatedWithout = gateToolCall([tool] as never, { id: 'w', name, argumentsRaw: JSON.stringify(without), malformed: false })
        if (gatedWithout.ok && (await validateWith(tool, gatedWithout.input)).ok) {
          culprit = key
          break
        }
      }
      defects.push(`${name}: validateInput refused the all-blanks form (${culprit ?? 'nested blank'}): ${blanksValid.message}`)
      row.blanks = `DEFECT in validateInput (${culprit ?? 'nested blank'})`
      continue
    }
    if (!plainValid.ok) {
      row.blanks = `same as plain (validateInput: ${plainValid.message.split('\n')[0]!.slice(0, 80)})`
      continue
    }
    const kept = parsedBlanks.ok ? Object.keys(parsedBlanks.input).filter(key => blankKeys.includes(key)) : []
    row.blanks = kept.length > 0 ? `passes (meaningful empties kept: ${kept.join(', ')})` : 'passes'
  }
  t('no tool refuses a placeholder that carries no meaning', defects.length === 0, defects.join(' | '))

  const read = roster.get('Read')!
  const astra = { file_path: PLAIN, offset: 1, limit: 2000, ranges: [], pages: '', crop: [0, 0, 0, 0], outline: false, line_anchors: false }
  const gated = gateToolCall([read] as never, { id: 'astra', name: 'Read', argumentsRaw: JSON.stringify(astra), malformed: false })
  t('Read: the exact Astra call (every box filled) passes the gate', gated.ok, gated.ok ? '' : gated.refusal.reason)
  if (gated.ok) {
    const verdict = await validateWith(read, gated.input)
    t('Read: the exact Astra call passes validateInput', verdict.ok, verdict.ok ? '' : verdict.message)
    try {
      const result = await (read as unknown as { call: Function }).call(gated.input, makeContext(), null, { uuid: '00000000-0000-0000-0000-000000000001', message: { id: 'msg_census_1' } })
      const notes = ((result.newMessages ?? []) as Array<{ message?: { content?: unknown } }>).map(m => String(m.message?.content ?? ''))
      t('Read: the exact Astra call reads the .md file with no refusal and no "ignored" note (the zero box is no crop at all)', result.data?.type === 'text' && !notes.some(note => note.includes('ignored')), `type=${result.data?.type} notes=${JSON.stringify(notes)}`)
    } catch (error) {
      t('Read: the exact Astra call reads the .md file', false, error instanceof Error ? error.message : String(error))
    }
  }
  const second = { file_path: PLAIN, offset: 1, limit: 2000, ranges: [], pages: '', crop: [0, 0, 1, 1], outline: false, line_anchors: false }
  const gated2 = gateToolCall([read] as never, { id: 'astra2', name: 'Read', argumentsRaw: JSON.stringify(second), malformed: false })
  if (gated2.ok) {
    const result = await (read as unknown as { call: Function }).call(gated2.input, makeContext(), null, { uuid: '00000000-0000-0000-0000-000000000002', message: { id: 'msg_census_2' } })
    const notes = ((result.newMessages ?? []) as Array<{ message?: { content?: unknown } }>).map(m => String(m.message?.content ?? ''))
    t('Read: the other seat\'s [0,0,1,1] box on a .md file reads the file and attaches the one "crop ignored" note (the lead\'s net stays)', result.data?.type === 'text' && notes.filter(note => note.includes('crop ignored')).length === 1, JSON.stringify(notes))
  } else t('Read: the [0,0,1,1] form passes the gate', false, gated2.refusal.reason)
  const edit = roster.get('Edit')!
  const editDelete = gateToolCall([edit] as never, { id: 'e', name: 'Edit', argumentsRaw: JSON.stringify({ file_path: PLAIN, old_string: 'body line', new_string: '' }), malformed: false })
  t('Edit: new_string "" is meaningful (a deletion) and is kept by the gate, never stripped as a blank', editDelete.ok && editDelete.input.new_string === '', editDelete.ok ? JSON.stringify(editDelete.input) : editDelete.refusal.reason)
  const shared = makeContext() as { readFileState: unknown }
  await (read as unknown as { call: Function }).call({ file_path: PLAIN }, shared, null, { uuid: '00000000-0000-0000-0000-000000000003', message: { id: 'msg_census_3' } })
  const editBlanks = gateToolCall([edit] as never, { id: 'eb', name: 'Edit', argumentsRaw: JSON.stringify({ file_path: PLAIN, old_string: 'body line', new_string: 'x', expected_anchor: '', replace_all: false, hunks: [], append: '', section: '' }), malformed: false })
  t('Edit: a replace with every other optional box blank reaches validateInput as the plain replace (the blanks read as absent)', editBlanks.ok && JSON.stringify(Object.keys(editBlanks.input).sort()) === JSON.stringify(['file_path', 'new_string', 'old_string', 'replace_all']), editBlanks.ok ? JSON.stringify(editBlanks.input) : editBlanks.refusal.reason)
  if (editBlanks.ok) {
    const verdict = await (edit.validateInput as Function)(editBlanks.input, shared)
    t('Edit: validateInput accepts that replace after a Read in the same session', verdict.result === true, String(verdict.message ?? ''))
  }
  const changeSet = roster.get('ChangeSet')!
  const previewBlanks = gateToolCall([changeSet] as never, { id: 'cb', name: 'ChangeSet', argumentsRaw: JSON.stringify({ op: 'preview', plan_id: '', changes: [{ file_path: PLAIN, expected_anchor: 'fa:0000000000', hunks: [{ lines: '1', replace: 'x' }] }] }), malformed: false })
  t('ChangeSet: a preview with plan_id "" (the either/or box filled blank) reaches validateInput without the box', previewBlanks.ok && !('plan_id' in previewBlanks.input) && (await (changeSet.validateInput as Function)(previewBlanks.input, makeContext())).result === true, previewBlanks.ok ? JSON.stringify(previewBlanks.input) : previewBlanks.refusal.reason)
  const jev = roster.get('JevEval')!
  const noul = gateToolCall([jev] as never, { id: 'j', name: 'JevEval', argumentsRaw: JSON.stringify({ goal: 'g', evidence: [{ fact: 'x' }], questions: [{ id: 'q', kind: 'noul', ask: 'does it hold', levels: [], none_means: '', allow_none: false }] }), malformed: false })
  const parsedNoul = noul.ok ? (jev.inputSchema.safeParse(noul.input) as { success: boolean; data?: { questions: Node[] } }) : undefined
  t('JevEval: a noul question with the choice/score boxes blank (levels [], none_means "", allow_none false) is admitted and parses to the plain question', noul.ok && parsedNoul?.success === true && JSON.stringify(parsedNoul.data?.questions[0]) === JSON.stringify({ id: 'q', kind: 'noul', ask: 'does it hold' }), noul.ok ? JSON.stringify(parsedNoul?.data?.questions[0]) : noul.refusal.reason)
  const choice = gateToolCall([jev] as never, { id: 'j2', name: 'JevEval', argumentsRaw: JSON.stringify({ goal: 'g', evidence: [{ fact: 'x' }], questions: [{ id: 'q', kind: 'choice', ask: 'which', options: { a: null, b: null }, allow_none: false }] }), malformed: false })
  const parsedChoice = choice.ok ? (jev.inputSchema.safeParse(choice.input) as { success: boolean; data?: { questions: Node[] } }) : undefined
  t('JevEval: allow_none false on a choice question stays (there it is meaningful and required)', choice.ok && parsedChoice?.success === true && parsedChoice.data?.questions[0]!.allow_none === false, choice.ok ? JSON.stringify(parsedChoice?.data?.questions[0]) : choice.refusal.reason)
  const emptyChoice = gateToolCall([jev] as never, { id: 'j3', name: 'JevEval', argumentsRaw: JSON.stringify({ goal: 'g', evidence: [{ fact: 'x' }], questions: [{ id: 'q', kind: 'choice', ask: 'which', options: {} }] }), malformed: false })
  t('JevEval: a choice question with empty options is still refused (an empty map is meaningful there: no options at all)', !emptyChoice.ok, emptyChoice.ok ? JSON.stringify(emptyChoice.input) : '')
}

section('§6 the structured-output converter is untouched')
{
  const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] }
  const strict = toOpenaiStrictSchema(schema) as Node
  t('toOpenaiStrictSchema still spells optional as a type union and closes the object', JSON.stringify(strict) === JSON.stringify({ type: 'object', properties: { a: { type: 'string' }, b: { type: ['number', 'null'] } }, required: ['a', 'b'], additionalProperties: false }), JSON.stringify(strict))
  t('toOpenaiStrictSchema is idempotent', JSON.stringify(toOpenaiStrictSchema(strict)) === JSON.stringify(strict))
  t('stripExplicitNulls still drops every null key recursively and keeps array nulls', JSON.stringify(stripExplicitNulls({ a: null, b: { c: null, d: [null, 1] } })) === JSON.stringify({ b: { d: [null, 1] } }))
  t('the tool dialect is a sibling, not a rewrite: the two converters differ on a constrained optional (anyOf spelling vs type union)', JSON.stringify(toOpenaiStrictToolSchema({ type: 'object', properties: { n: { type: 'integer', minimum: 0 } } })) !== JSON.stringify(toOpenaiStrictSchema({ type: 'object', properties: { n: { type: 'integer', minimum: 0 } } })))
}

section('§7 the census table (tool · strict or not · why · all-blanks verdict)')
const width = Math.max(...rows.map(r => r.tool.length))
for (const row of rows.sort((a, b) => a.tool.localeCompare(b.tool))) console.log(`  ${row.tool.padEnd(width)}  ${row.strict.padEnd(10)}  ${row.why}  ·  ${row.blanks}`)
const strictCount = rows.filter(r => r.strict === 'strict').length
console.log(`\n  ${strictCount} strict · ${rows.length - strictCount} non-strict · ${rows.length} rows`)
writeFileSync(join(SCRATCH, 'census.json'), JSON.stringify(rows, null, 1))
console.log(`  table written to ${join(SCRATCH, 'census.json')}`)

clearTimeout(watchdog)
rmSync(WORK, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failed`)
if (failures > 0) {
  console.log('RED: prove-tool-forms-census.ts')
  process.exit(1)
}
console.log('ALL GREEN')
process.exit(0)
