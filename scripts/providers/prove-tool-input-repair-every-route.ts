#!/usr/bin/env bun
// gate-watch: src/services/providers/local/schemaTyping.ts src/services/providers/toolCallGate.ts src/services/tools/toolExecution.ts src/services/providers/openaicompat/compatChatCallModel.ts src/services/providers/openai/openaiCallModel.ts src/services/providers/zai/zaiCallModel.ts
import { readFileSync } from 'node:fs'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { repairArgumentsBySchema } = await import('../../src/services/providers/local/schemaTyping.ts')
const { gateToolCall, repairToolInput } = await import('../../src/services/providers/toolCallGate.ts')
const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

type Schema = Record<string, unknown>
const j = (v: unknown): string => JSON.stringify(v)

section('W1 · the walker types nested strings by the declared schema, properties and items alike')
{
  const schema: Schema = {
    type: 'object',
    properties: {
      limit: { type: 'integer' },
      options: {
        type: 'object',
        properties: {
          depth: { type: 'integer' },
          strict: { type: 'boolean' },
          filters: { type: 'object', properties: { minimum: { type: 'number' }, label: { type: 'string' } } },
        },
      },
      rows: { type: 'array', items: { type: 'object', properties: { count: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } } } },
      weights: { type: 'array', items: { type: 'number' } },
      window: { anyOf: [{ type: 'null' }, { type: 'object', properties: { start: { type: 'integer' } } }] },
    },
  }
  const sent = {
    limit: '5',
    options: { depth: '3', strict: 'true', filters: '{"minimum":"0.5","label":"12"}' },
    rows: [{ count: '2', tags: 'a' }, '{"count":"7","tags":["x","y"]}'],
    weights: ['1', '2.5', 3],
    window: '{"start":"9"}',
  }
  const before = j(sent)
  const out = repairArgumentsBySchema(sent, schema)
  check('a top-level integer string is typed', out.limit === 5, j(out))
  check('strings inside a nested object are typed', j(out.options) === j({ depth: 3, strict: true, filters: { minimum: 0.5, label: '12' } }), j(out.options))
  check('a stringified nested object is parsed and then typed inside', (out.options as Schema).filters !== undefined && ((out.options as Schema).filters as Schema).minimum === 0.5)
  check('array items are typed, a lone string under an array of strings is wrapped, a stringified item is parsed', j(out.rows) === j([{ count: 2, tags: ['a'] }, { count: 7, tags: ['x', 'y'] }]), j(out.rows))
  check('number strings inside an array of numbers are typed', j(out.weights) === j([1, 2.5, 3]), j(out.weights))
  check('an anyOf arm with properties is followed into', j(out.window) === j({ start: 9 }), j(out.window))
  check('the sent object is never mutated', j(sent) === before)
}

section('W2 · a lone value where the schema wants an array is wrapped only when it could be an item')
{
  const schema: Schema = {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      counts: { type: 'array', items: { type: 'integer' } },
      people: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
      anything: { type: 'array' },
      flags: { type: 'array', items: { type: 'boolean' } },
      pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] },
    },
  }
  const out = repairArgumentsBySchema({ paths: 'src/', counts: 4, people: { name: 'Ada' }, anything: 'x', flags: 'maybe', pair: 'x' }, schema)
  check('a lone string under an array of strings becomes the one item', j(out.paths) === j(['src/']), j(out.paths))
  check('a lone integer under an array of integers becomes the one item', j(out.counts) === j([4]), j(out.counts))
  check('a lone object under an array of objects becomes the one item', j(out.people) === j([{ name: 'Ada' }]), j(out.people))
  check('an array with no item type takes any lone value', j(out.anything) === j(['x']), j(out.anything))
  check('a string the item type cannot take stays as sent, so the schema refuses it with its words', out.flags === 'maybe', j(out.flags))
  check('a tuple-shaped items list never wraps', out.pair === 'x', j(out.pair))
  const typed = repairArgumentsBySchema({ counts: '["1","2"]', people: '{"name":"Lin"}', paths: '42' }, schema)
  check('a JSON array string under an array is parsed and its items typed', j(typed.counts) === j([1, 2]), j(typed.counts))
  check('a JSON object string under an array of objects is parsed and wrapped', j(typed.people) === j([{ name: 'Lin' }]), j(typed.people))
  check('a digit string under an array of strings stays a string item', j(typed.paths) === j(['42']), j(typed.paths))
}

section('W3 · what the walker leaves alone')
{
  const closed: Schema = { type: 'object', additionalProperties: false, properties: { known: { type: 'string' }, inner: { type: 'object', additionalProperties: false, properties: { a: { type: 'integer' } } } } }
  const sent = { known: 'k', stray: '1', inner: { a: '2', extra: true } }
  const out = repairArgumentsBySchema(sent, closed)
  check('an undeclared key on a closed object is left for the schema to name (the refusal teaches the right name)', out.stray === '1' && (out.inner as Schema).extra === true, j(out))
  check('the declared neighbours are still typed', (out.inner as Schema).a === 2, j(out))
  const same = { known: 'k', inner: { a: 2 } }
  check('nothing to repair ⇒ the same object comes back', repairArgumentsBySchema(same, closed) === same)
  check('no schema ⇒ the same object comes back', repairArgumentsBySchema(same, undefined) === same && repairArgumentsBySchema(same, { type: 'object' }) === same)
  const union: Schema = { type: 'object', properties: { either: { type: ['string', 'integer'] }, choice: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } }
  const left = repairArgumentsBySchema({ either: '7', choice: '8' }, union)
  check('a union that admits string keeps the string', left.either === '7' && left.choice === '8', j(left))
  let node: Schema = { type: 'integer' }
  for (let level = 0; level < 12; level++) node = { type: 'object', properties: { next: node } }
  let value: unknown = '1'
  for (let level = 0; level < 12; level++) value = { next: value }
  const deep = repairArgumentsBySchema({ next: value } as Schema, { type: 'object', properties: { next: node } })
  let probe: unknown = deep
  for (let level = 0; level < 13; level++) probe = (probe as Schema).next
  check('the walk stops at its depth bound and leaves the rest as sent', probe === '1', j(deep).slice(0, 200))
}

section('G1 · the gate types by the declared schema on every route — the callers that pass no wire schema')
{
  const tool = {
    name: 'RepairProbe',
    inputSchema: z.strictObject({
      limit: z.number(),
      paths: z.array(z.string()).optional(),
      options: z.object({ depth: z.number(), strict: z.boolean() }).optional(),
    }),
    prompt: async () => 'probe',
  }
  const call = (args: unknown) => gateToolCall([tool] as never, { id: 'call_1', name: tool.name, argumentsRaw: JSON.stringify(args), malformed: false })
  const hosted = call({ limit: '20', paths: 'src/', options: { depth: '2', strict: 'false' } })
  check('a hosted-route call with stringified numbers, a lone path and nested strings mints typed', hosted.ok && j(hosted.input) === j({ limit: 20, paths: ['src/'], options: { depth: 2, strict: false } }), j(hosted))
  const typed = call({ limit: 20, paths: ['src/'] })
  check('a well-typed call mints exactly what was sent', typed.ok && j(typed.input) === j({ limit: 20, paths: ['src/'] }), j(typed))
  const bad = call({ limit: 'twenty' })
  check('a string no type can take is still refused with the type sentence', !bad.ok && bad.refusal.code === 'schema' && bad.refusal.reason.includes('expects type number, got string'), j(bad))
  const stray = call({ limit: 1, nope: true })
  check('an undeclared key on a strict tool is still the refusal that names it', !stray.ok && stray.refusal.code === 'schema' && stray.refusal.reason.includes('`nope` was not expected'), j(stray))
  const mcp = {
    name: 'mcp__shop__order',
    inputSchema: z.record(z.string(), z.unknown()),
    prompt: async () => 'order',
    inputJSONSchema: {
      type: 'object',
      properties: { lines: { type: 'array', items: { $ref: '#/$defs/Line' } }, rush: { type: 'boolean' } },
      $defs: { Line: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } } } },
    },
  }
  const viaRefs = gateToolCall([mcp] as never, { id: 'call_2', name: mcp.name, argumentsRaw: JSON.stringify({ lines: { sku: 'A1', qty: '3' }, rush: 'true' }), malformed: false })
  check('an MCP schema with $refs is read through its inlined form: the lone line is wrapped and typed, the flag typed', viaRefs.ok && j(viaRefs.input) === j({ lines: [{ sku: 'A1', qty: 3 }], rush: true }), j(viaRefs))
}

section('E1 · the executor road every wire takes: a tool_use whose input arrived mistyped runs typed')
{
  const seen: unknown[] = []
  const tool = {
    name: 'ExecutorRepairProbe',
    inputSchema: z.strictObject({ count: z.number(), labels: z.array(z.string()).optional(), nested: z.object({ on: z.boolean() }).optional() }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    checkPermissions: async (input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    call: async (input: unknown) => {
      seen.push(input)
      return { data: 'ran' }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => ({ type: 'tool_result', tool_use_id: toolUseID, content: String(data) }),
  }
  const appState = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }
  const context = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    toolDecisions: new Map(),
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
  }
  const run = async (input: unknown) => {
    const results: Array<{ is_error?: boolean; content?: unknown }> = []
    for await (const update of runToolUse(
      { type: 'tool_use', id: `exec-${results.length}-${Math.random().toString(36).slice(2, 8)}`, name: tool.name, input } as never,
      { uuid: 'exec-assistant', message: { id: 'exec-message' } } as never,
      (async () => ({ behavior: 'allow' })) as never,
      context as never,
    )) {
      const message = (update as { message: { type: string; message: { content: unknown } } }).message
      if (message.type === 'user' && Array.isArray(message.message.content)) results.push(...(message.message.content as Array<{ type: string; is_error?: boolean; content?: unknown }>).filter(b => b.type === 'tool_result'))
    }
    return results
  }
  const repaired = await run({ count: '3', labels: 'one', nested: { on: 'true' } })
  check('the mistyped input runs instead of refusing', repaired.length === 1 && repaired[0]!.is_error !== true, j(repaired))
  check('the tool received the typed input', j(seen[0]) === j({ count: 3, labels: ['one'], nested: { on: true } }), j(seen))
  const refused = await run({ count: 'three' })
  check('an input no typing can repair is the refusal it is today', refused.length === 1 && refused[0]!.is_error === true && String(refused[0]!.content).includes('`count`'), j(refused))
  check('a refused input never ran the tool', seen.length === 1)
  const direct = repairToolInput(tool, { count: '9' })
  check('repairToolInput reads the tool\u2019s own schema', j(direct) === j({ count: 9 }), j(direct))
  const malformed = { count: '4', labels: null, nested: { on: 'false' } } as Record<string, unknown>
  const viaGate = gateToolCall([tool] as never, { id: 'call_both', name: tool.name, argumentsRaw: JSON.stringify(malformed), malformed: false })
  const viaExecutor = repairToolInput(tool, malformed)
  check('ONE PIPELINE: the text-wire gate and the executor road repair the same malformed call identically (nulls in optional slots dropped, strings typed)', viaGate.ok && j(viaGate.input) === j(viaExecutor) && j(viaExecutor) === j({ count: 4, nested: { on: false } }), j({ viaGate, viaExecutor }))
  const nullOnAnthropicRoad = await run({ count: '5', labels: null })
  check('a null in an optional slot on the executor road (the Anthropic wire) is dropped and the call runs, as the text-wire gate already did', nullOnAnthropicRoad.length === 1 && nullOnAnthropicRoad[0]!.is_error !== true && j(seen[1]) === j({ count: 5 }), j({ nullOnAnthropicRoad, seen }))
  const toolSource = readFileSync(new URL('../../src/services/tools/toolExecution.ts', import.meta.url), 'utf8')
  const gateSource = readFileSync(new URL('../../src/services/providers/toolCallGate.ts', import.meta.url), 'utf8')
  check('the executor imports the gate\u2019s repairToolInput and the gate calls the same function before its own validation (one owner, two callers)', toolSource.includes("import { repairToolInput } from '../providers/toolCallGate.js'") && gateSource.includes('const input = repairToolInput(tool, straightened)'))
}

section('refusals · what the repair must never do with arguments it does not trust')
{
  const schema: Schema = { type: 'object', properties: { n: { type: 'integer' }, o: { type: 'object', properties: { x: { type: 'integer' } } }, list: { type: 'array', items: { type: 'integer' } }, s: { type: 'string' } } }
  const poisoned = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"n":"1"}') as Schema
  const out = repairArgumentsBySchema(poisoned, schema)
  check('a __proto__ or constructor key in the arguments never reaches an assignment: the repaired object has the plain prototype and no pollution', Object.getPrototypeOf(out) === Object.prototype && (out as { polluted?: unknown }).polluted === undefined && ({} as { polluted?: unknown }).polluted === undefined && out.n === 1, j(out))
  const inherited = Object.create({ n: { type: 'boolean' } }) as Schema
  check('a property the schema inherits rather than declares is not a declaration', repairArgumentsBySchema({ n: 'true' }, { type: 'object', properties: inherited }).n === 'true')
  const huge = 'x'.repeat(2_000_000)
  const started = Date.now()
  const big = repairArgumentsBySchema({ n: huge, o: huge, list: huge, s: huge }, schema)
  check(`a two-megabyte string under every type is bounded by its own size and stays text where no type takes it (${Date.now() - started} ms)`, big.n === huge && big.o === huge && big.s === huge && Date.now() - started < 2_000, j({ n: typeof big.n, o: typeof big.o, list: typeof big.list }))
  check('a two-megabyte string under an array of integers is wrapped only if the item type admits it — it does not, so it stays text', big.list === huge)
  const nested = '['.repeat(200_000) + ']'.repeat(200_000)
  let thrown: unknown = null
  let deep: Schema = {}
  try {
    deep = repairArgumentsBySchema({ o: nested, list: nested }, schema)
  } catch (error) {
    thrown = error
  }
  check('a 200,000-deep JSON text never throws out of the repair: it is left as text or parsed, never a crash', thrown === null && (typeof deep.o === 'string' || typeof deep.o === 'object'), String(thrown))
  const jsonArray = `[${Array.from({ length: 100_000 }, (_, i) => `"${i}"`).join(',')}]`
  const parsed = repairArgumentsBySchema({ list: jsonArray }, schema)
  check('a 100,000-item JSON array string is parsed once and every item typed, the work linear in the input', Array.isArray(parsed.list) && (parsed.list as unknown[]).length === 100_000 && (parsed.list as number[])[99_999] === 99_999)
  const control = repairArgumentsBySchema({ s: '{"a":1}', n: 7, list: [1, 2], o: { x: 3 } }, schema)
  check('the control: a declared string is never parsed whatever it looks like, and typed values come back as the same object', control.s === '{"a":1}' && control === repairArgumentsBySchema(control, schema))
  const words = gateToolCall([{ name: 'Words', inputSchema: z.strictObject({ limit: z.number() }), prompt: async () => 'w' }] as never, { id: 'w1', name: 'Words', argumentsRaw: '{"limit":"twenty"}', malformed: false })
  check('the refusal words are the fold tip\u2019s: the typed sentence, unchanged', !words.ok && words.refusal.reason.includes('Parameter `limit` expects type number, got string'), j(words))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
