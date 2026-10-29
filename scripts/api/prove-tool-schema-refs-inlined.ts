#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { codeAssistSchema } = await import('../../src/services/providers/gemini/geminiCodec.ts')
const { mapToolsToOpenai } = await import('../../src/services/providers/openai/responsesBridge.ts')

type Schema = Record<string, unknown>

function fakeTool(name: string, schema: Schema): Record<string, unknown> {
  return { name, prompt: async () => `description of ${name}`, inputJSONSchema: schema }
}

const wireOf = async (tool: Record<string, unknown>, model = 'claude-sonnet-5'): Promise<Schema> => {
  clearToolSchemaCache()
  const built = await toolToAPISchema(tool as never, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [tool] as never,
    agents: [],
    model,
  })
  return (built as { input_schema: Schema }).input_schema
}

const refsIn = (node: unknown, found: string[] = []): string[] => {
  if (Array.isArray(node)) node.forEach(child => refsIn(child, found))
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Schema)) {
      if (key === '$ref' && typeof value === 'string') found.push(value)
      else refsIn(value, found)
    }
  }
  return found
}
const path = (node: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((at, key) => (at !== null && typeof at === 'object' ? (at as Schema)[key] : undefined), node)

section('R1 · an MCP schema with $defs and nested $refs reaches the wire flat')
{
  const schema: Schema = {
    type: 'object',
    properties: {
      address: { $ref: '#/$defs/Address', description: 'where it ships' },
      previous: { type: 'array', items: { $ref: '#/$defs/Address' } },
      status: { anyOf: [{ $ref: '#/$defs/Status' }, { type: 'null' }] },
    },
    required: ['address'],
    $defs: {
      Address: {
        type: 'object',
        properties: { city: { type: 'string' }, region: { $ref: '#/$defs/Region' } },
        required: ['city'],
        additionalProperties: false,
      },
      Region: { type: 'string', enum: ['north', 'south'] },
      Status: { type: 'string', enum: ['open', 'closed'] },
    },
  }
  const before = JSON.stringify(schema)
  const wire = await wireOf(fakeTool('mcp__shop__ship', schema))
  const refs = refsIn(wire)
  check('no $ref remains anywhere in the wire schema', refs.length === 0, `refs=${JSON.stringify(refs)}`)
  check('the resolved $defs table is dropped', !('$defs' in wire), JSON.stringify(Object.keys(wire)))
  check('a property $ref is inlined with the definition in place', path(wire, 'properties', 'address', 'properties', 'city', 'type') === 'string', JSON.stringify(path(wire, 'properties', 'address')))
  check('a $ref inside the inlined definition is inlined too (two levels)', JSON.stringify(path(wire, 'properties', 'address', 'properties', 'region', 'enum')) === '["north","south"]', JSON.stringify(path(wire, 'properties', 'address', 'properties', 'region')))
  check('the words beside the $ref survive and win', path(wire, 'properties', 'address', 'description') === 'where it ships', JSON.stringify(path(wire, 'properties', 'address')))
  check('an items $ref is inlined', path(wire, 'properties', 'previous', 'items', 'type') === 'object' && path(wire, 'properties', 'previous', 'items', 'additionalProperties') === false, JSON.stringify(path(wire, 'properties', 'previous')))
  check('an anyOf arm $ref is inlined', JSON.stringify(path(wire, 'properties', 'status', 'anyOf', '0', 'enum')) === '["open","closed"]', JSON.stringify(path(wire, 'properties', 'status')))
  check('required and the closed-object mark travel with the inlined definition', JSON.stringify(path(wire, 'properties', 'address', 'required')) === '["city"]' && path(wire, 'properties', 'address', 'additionalProperties') === false)
  check('the tool\u2019s own schema object is never mutated', JSON.stringify(schema) === before)
  const gemini = codeAssistSchema(wire) as Schema
  check('the Gemini grammar keeps the nested object (it dropped a $ref property to {} before)', path(gemini, 'properties', 'address', 'type') === 'object' && path(gemini, 'properties', 'address', 'properties', 'city', 'type') === 'string', JSON.stringify(path(gemini, 'properties', 'address')))
  const openai = mapToolsToOpenai([{ name: 'mcp__shop__ship', input_schema: wire }] as never)
  check('the OpenAI function parameters carry the same flat schema', refsIn(openai).length === 0 && path(openai[0], 'parameters', 'properties', 'address', 'type') === 'object')
}

section('R2 · a recursive schema keeps the cycle and its definitions, the acyclic parts still inlined')
{
  const schema: Schema = {
    type: 'object',
    properties: {
      tree: { $ref: '#/$defs/Node' },
      owner: { $ref: '#/$defs/Owner' },
    },
    $defs: {
      Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } },
      Owner: { type: 'object', properties: { name: { type: 'string' } } },
    },
  }
  const wire = await wireOf(fakeTool('mcp__files__tree', schema))
  const refs = refsIn(wire)
  check('the self-reference stays a $ref', refs.length >= 1 && refs.every(ref => ref === '#/$defs/Node'), JSON.stringify(refs))
  check('the $defs table is kept while a $ref still points into it', path(wire, '$defs', 'Node', 'type') === 'object', JSON.stringify(Object.keys(wire)))
  check('the recursive property is inlined one level', path(wire, 'properties', 'tree', 'type') === 'object' && path(wire, 'properties', 'tree', 'properties', 'name', 'type') === 'string', JSON.stringify(path(wire, 'properties', 'tree')))
  check('the acyclic definition beside it is inlined', path(wire, 'properties', 'owner', 'properties', 'name', 'type') === 'string', JSON.stringify(path(wire, 'properties', 'owner')))
}

section('R3 · draft-07 definitions, escaped pointers and a root-level $ref')
{
  const schema: Schema = {
    $ref: '#/definitions/a~1b',
    definitions: {
      'a/b': { type: 'object', properties: { tilde: { $ref: '#/definitions/x~0y' }, encoded: { $ref: '#/definitions/sp%20ace' } } },
      'x~y': { type: 'integer' },
      'sp ace': { type: 'boolean' },
    },
  }
  const wire = await wireOf(fakeTool('mcp__legacy__root', schema))
  check('a root $ref becomes the definition itself', wire.type === 'object' && path(wire, 'properties', 'tilde', 'type') === 'integer', JSON.stringify(wire))
  check('~1, ~0 and percent escapes resolve', path(wire, 'properties', 'encoded', 'type') === 'boolean', JSON.stringify(wire))
  check('the resolved definitions table is dropped', !('definitions' in wire) && refsIn(wire).length === 0, JSON.stringify(Object.keys(wire)))
}

section('R4 · what is not ours to resolve is left alone')
{
  const remote: Schema = { type: 'object', properties: { far: { $ref: 'https://example.invalid/schemas/far.json#/Far' } } }
  const wire = await wireOf(fakeTool('mcp__remote__far', remote))
  check('a non-local $ref is untouched', path(wire, 'properties', 'far', '$ref') === 'https://example.invalid/schemas/far.json#/Far')
  const dangling: Schema = { type: 'object', properties: { lost: { $ref: '#/$defs/Missing' }, kept: { $ref: '#/$defs/Kept' } }, $defs: { Kept: { type: 'string' } } }
  const wire2 = await wireOf(fakeTool('mcp__remote__lost', dangling))
  check('a dangling local $ref stays, with the $defs it may need', path(wire2, 'properties', 'lost', '$ref') === '#/$defs/Missing' && '$defs' in wire2, JSON.stringify(wire2))
  check('the resolvable neighbour is still inlined', path(wire2, 'properties', 'kept', 'type') === 'string', JSON.stringify(wire2))
  const data: Schema = { type: 'object', properties: { body: { type: 'object', default: { $ref: 'a value, not a pointer' }, enum: [{ $ref: '#/x' }] } } }
  const wire3 = await wireOf(fakeTool('mcp__remote__data', data))
  check('a $ref inside a default or enum value is data and is never touched', JSON.stringify(path(wire3, 'properties', 'body')) === JSON.stringify(data.properties && (data.properties as Schema).body), JSON.stringify(wire3))
}

section('R5 · a schema without refs is the very same object on the wire')
{
  const plain: Schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  const wire = await wireOf(fakeTool('mcp__plain__echo', plain))
  check('no refs ⇒ identity (nothing changes on a normal day)', wire === plain)
  const { z } = await import('zod/v4')
  const zodTool = { name: 'zod-typed', prompt: async () => 'zod', inputSchema: z.object({ count: z.number(), tags: z.array(z.string()).optional() }) }
  const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
  const zodWire = await wireOf(zodTool as never)
  check('a zod-derived schema is byte-identical to its converter\u2019s output', JSON.stringify(zodWire) === JSON.stringify(zodToJsonSchema(zodTool.inputSchema as never)))
}

section('R6 · a heavily shared definition tree stays bounded')
{
  const defs: Schema = {}
  const levels = 14
  for (let level = 0; level < levels; level++) {
    const next = level + 1 < levels ? { $ref: `#/$defs/L${level + 1}` } : { type: 'string' }
    defs[`L${level}`] = { type: 'object', properties: { a: next, b: next, c: next, d: next } }
  }
  const schema: Schema = { type: 'object', properties: { root: { $ref: '#/$defs/L0' } }, $defs: defs }
  const started = Date.now()
  const wire = await wireOf(fakeTool('mcp__wide__tree', schema))
  const bytes = JSON.stringify(wire).length
  check('the walk finishes and the output stays under a few megabytes', bytes < 4_000_000, `bytes=${bytes} ms=${Date.now() - started}`)
  check('whatever stayed a $ref still has its $defs beside it', refsIn(wire).length === 0 || '$defs' in wire)
}

section('refusals · what the walker must never do with a schema it does not trust')
{
  const { inlineLocalSchemaRefs } = await import('../../src/utils/inlineSchemaRefs.ts')
  const flat = (schema: Schema): Schema => inlineLocalSchemaRefs(schema)
  const notAString = flat({ type: 'object', properties: { a: { $ref: 42, type: 'string' } } })
  check('a $ref that is not a string is left exactly as it came', JSON.stringify(path(notAString, 'properties', 'a')) === JSON.stringify({ $ref: 42, type: 'string' }))
  const badEscape = flat({ type: 'object', properties: { a: { $ref: '#/$defs/%E0%A4%A' } }, $defs: { x: { type: 'string' } } })
  check('a pointer with a broken percent escape stays a $ref, its $defs kept, nothing thrown', path(badEscape, 'properties', 'a', '$ref') === '#/$defs/%E0%A4%A' && '$defs' in badEscape)
  const nonSchema = flat({ type: 'object', properties: { a: { $ref: '#/$defs/n', description: 'kept' } }, $defs: { n: 42 } })
  check('a $ref to a value that is neither a schema nor a boolean stays a $ref — never an accept-anything {}', path(nonSchema, 'properties', 'a', '$ref') === '#/$defs/n' && path(nonSchema, 'properties', 'a', 'description') === 'kept' && '$defs' in nonSchema)
  const selfRoot = flat({ $ref: '#', type: 'object' })
  check('a root that points at itself is a cycle and stays', selfRoot.$ref === '#')
  const big = { type: 'object', properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, { type: 'string', description: 'x'.repeat(60) }])) }
  const bigSchema: Schema = { type: 'object', properties: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`p${i}`, { $ref: '#/$defs/Big' }])), $defs: { Big: big } }
  const bigSize = JSON.stringify(big).length
  const started = Date.now()
  const bounded = flat(bigSchema)
  const outBytes = JSON.stringify(bounded).length
  check(`a definition of ${bigSize} bytes referenced 120 times is charged before each copy: the output stays under the ceiling plus one definition, the rest stay refs with $defs kept (${outBytes} bytes, ${Date.now() - started} ms)`, outBytes < 1_000_000 + bigSize + 20_000 && refsIn(bounded).length > 0 && '$defs' in bounded, `bytes=${outBytes}`)
  const deepDefs: Schema = {}
  for (let i = 0; i < 60; i++) deepDefs[`D${i}`] = { type: 'object', properties: { next: i + 1 < 60 ? { $ref: `#/$defs/D${i + 1}` } : { type: 'string' } } }
  const deep = flat({ type: 'object', properties: { root: { $ref: '#/$defs/D0' } }, $defs: deepDefs })
  check('a 60-deep chain stops at the nesting limit: some refs remain, $defs kept, nothing thrown', refsIn(deep).length > 0 && '$defs' in deep)
  const poisoned = flat(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"$ref":"#/$defs/S"}},"$defs":{"S":{"type":"integer"}}}') as Schema)
  check('a property named __proto__ is never written through assignment: the walked table has the plain prototype and no such key', Object.getPrototypeOf(path(poisoned, 'properties')) === Object.prototype && !Object.prototype.hasOwnProperty.call(path(poisoned, 'properties') as object, '__proto__') && path(poisoned, 'properties', 'ok', 'type') === 'integer')
  const { getAllBaseTools } = await import('../../src/tools.ts')
  const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
  let identical = 0
  let differed: string[] = []
  for (const tool of getAllBaseTools() as unknown as Array<{ name: string; inputSchema?: unknown; inputJSONSchema?: unknown; prompt: unknown }>) {
    if (tool.inputJSONSchema !== undefined || tool.inputSchema === undefined) continue
    let wire: Schema
    try {
      wire = await wireOf(tool as never, 'claude-sonnet-5')
    } catch {
      continue
    }
    if (JSON.stringify(wire) === JSON.stringify(flat(zodToJsonSchema(tool.inputSchema as never) as Schema))) identical++
    else differed.push(tool.name)
  }
  check(`the control over the prefix bytes: every built-in tool's wire schema is byte-identical to its converted and reference-inlined schema (${identical} tools), none differ`, identical > 20 && differed.length === 0, differed.join(', '))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
