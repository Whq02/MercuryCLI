#!/usr/bin/env bun

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'tool-output-schema-check-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TRACE = '1'
delete process.env.NODE_ENV
delete process.env.MERCURY_HOME

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

const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
const { enableDebugLogging, flushDebugLogs, getDebugLogPath } = await import('../../src/utils/debug.ts')
const { flushTraceNow, getInvocationTracePath } = await import('../../src/utils/observability/invocationTrace.ts')
const checkModule = (await import('../../src/services/tools/toolOutputCheck.ts').catch(() => null)) as { outputSchemaMismatch?: (tool: unknown, data: unknown) => string | undefined } | null
enableConfigs()
enableDebugLogging()

type Record_ = Record<string, unknown>
const j = (v: unknown): string => JSON.stringify(v)

function probeTool(name: string, outputSchema: unknown, answer: () => unknown) {
  return {
    name,
    inputSchema: z.strictObject({ ask: z.string() }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    checkPermissions: async (input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    call: async () => ({ data: answer() }),
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => ({ type: 'tool_result', tool_use_id: toolUseID, content: `reply:${j(data)}` }),
  }
}

const appState = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }
let calls = 0
async function run(tool: ReturnType<typeof probeTool>): Promise<{ results: Array<{ is_error?: boolean; content?: unknown }>; toolUseResult: unknown; id: string }> {
  const id = `out-${++calls}`
  const context = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    toolDecisions: new Map(),
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
  }
  const results: Array<{ is_error?: boolean; content?: unknown }> = []
  let toolUseResult: unknown
  for await (const update of runToolUse(
    { type: 'tool_use', id, name: tool.name, input: { ask: 'now' } } as never,
    { uuid: 'out-assistant', message: { id: 'out-message' } } as never,
    (async () => ({ behavior: 'allow' })) as never,
    context as never,
  )) {
    const message = (update as { message: { type: string; toolUseResult?: unknown; message: { content: unknown } } }).message
    if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
    results.push(...(message.message.content as Array<{ type: string; is_error?: boolean; content?: unknown }>).filter(b => b.type === 'tool_result'))
    toolUseResult = message.toolUseResult
  }
  return { results, toolUseResult, id }
}

async function debugLines(): Promise<string[]> {
  await flushDebugLogs()
  const path = getDebugLogPath()
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(line => line.includes('tool output mismatch')) : []
}
async function traceRecords(): Promise<Record_[]> {
  await flushTraceNow()
  const path = getInvocationTracePath()
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record_) : []
}

section('O1 · a result that misses its declared output schema: the reply is untouched, the debug log and the call\u2019s trace line record it')
{
  const tool = probeTool('OutputProbe', z.object({ count: z.number(), names: z.array(z.string()) }), () => ({ count: 'three', names: 'solo' }))
  const { results, toolUseResult } = await run(tool)
  check('the model sees the tool\u2019s own reply, not an error', results.length === 1 && results[0]!.is_error !== true && results[0]!.content === 'reply:{"count":"three","names":"solo"}', j(results))
  check('the stored toolUseResult is the data as returned', j(toolUseResult) === j({ count: 'three', names: 'solo' }), j(toolUseResult))
  const lines = await debugLines()
  check('the debug log names the tool and the fields that missed', lines.length === 1 && lines[0]!.includes('tool output mismatch for OutputProbe') && lines[0]!.includes('count') && lines[0]!.includes('names'), j(lines))
  const records = await traceRecords()
  const mine = records.filter(r => r.tool === 'OutputProbe')
  check('the call\u2019s trace line carries outputMismatch:true and ok:true', mine.length === 1 && mine[0]!.outputMismatch === true && mine[0]!.ok === true, j(mine))
}

section('O2 · a result that fits its schema, and a tool with no schema, leave no mark')
{
  const fits = probeTool('OutputFits', z.object({ count: z.number() }), () => ({ count: 3 }))
  const bare = probeTool('OutputBare', undefined, () => ({ anything: 'goes', count: 'nine' }))
  const a = await run(fits)
  const b = await run(bare)
  check('both replies are the tools\u2019 own', a.results[0]!.content === 'reply:{"count":3}' && b.results[0]!.content === 'reply:{"anything":"goes","count":"nine"}', j([a.results, b.results]))
  const lines = await debugLines()
  check('no new debug line for either', lines.length === 1, j(lines))
  const records = await traceRecords()
  check('neither trace line carries the mark', records.filter(r => r.tool === 'OutputFits' || r.tool === 'OutputBare').every(r => !('outputMismatch' in r)) && records.some(r => r.tool === 'OutputFits') && records.some(r => r.tool === 'OutputBare'), j(records))
}

section('O3 · a schema that throws while judging is a recorded mismatch, never a failed call')
{
  const throwing = probeTool('OutputThrows', { safeParse: () => { throw new Error('judge broke') } }, () => ({ fine: true }))
  const { results } = await run(throwing)
  check('the reply is the tool\u2019s own', results.length === 1 && results[0]!.is_error !== true && results[0]!.content === 'reply:{"fine":true}', j(results))
  const lines = await debugLines()
  check('the debug log says the schema could not judge the result', lines.length === 2 && lines[1]!.includes('OutputThrows') && lines[1]!.includes('could not judge') && lines[1]!.includes('judge broke'), j(lines))
  const records = await traceRecords()
  check('the trace line is marked', records.filter(r => r.tool === 'OutputThrows').every(r => r.outputMismatch === true && r.ok === true), j(records.filter(r => r.tool === 'OutputThrows')))
}

section('O4 · the judge itself: issues bounded, paths named')
{
  const fn = checkModule?.outputSchemaMismatch
  check('the check module exists (src/services/tools/toolOutputCheck.ts)', typeof fn === 'function')
  if (typeof fn === 'function') {
    const wide = z.object(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, z.number()])))
    const text = fn({ outputSchema: wide }, {})
    check('at most five issues are named, each with its path', text !== undefined && text.split('; ').length === 5 && text.startsWith('f0:'), text)
    const nested = fn({ outputSchema: z.object({ rows: z.array(z.object({ id: z.number() })) }) }, { rows: [{ id: 1 }, { id: 'two' }] })
    check('a nested path reads rows.1.id', nested !== undefined && nested.startsWith('rows.1.id:'), nested)
    check('a fitting result is no mismatch', fn({ outputSchema: z.object({ id: z.number() }) }, { id: 1 }) === undefined)
    check('no schema is no mismatch', fn({}, { id: 'x' }) === undefined)
    const long = fn({ outputSchema: z.object({ a: z.literal('x'.repeat(900)) }) }, { a: 'y' })
    check('the text is cut at 400 characters', long !== undefined && long.length <= 401, String(long?.length))
  }
}

section('refusals · what the judge must never do with a result or a schema it does not trust')
{
  const fn = checkModule?.outputSchemaMismatch
  if (typeof fn === 'function') {
    const blob = 'x'.repeat(5_000_000)
    const started = Date.now()
    const text = fn({ outputSchema: z.object({ content: z.number() }) }, { content: blob })
    check(`a five-megabyte result that misses its schema is judged in bounded time and the text never carries the value (${Date.now() - started} ms)`, text !== undefined && text.length <= 401 && !text.includes('xxxx') && Date.now() - started < 3_000, String(text?.length))
    check('a five-megabyte result that fits is no mismatch', fn({ outputSchema: z.object({ content: z.string() }) }, { content: blob }) === undefined)
    check('a schema whose safeParse answers garbage is a worded mismatch, never a crash', fn({ outputSchema: { safeParse: () => 'nope' } as never }, {}) === 'the result does not match the declared output schema' && fn({ outputSchema: { safeParse: () => null } as never }, {}) !== undefined)
    check('a schema whose safeParse answers a promise is a worded mismatch, never an unhandled wait', typeof fn({ outputSchema: { safeParse: async () => ({ success: true }) } as never }, {}) === 'string')
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    check('a circular result under a schema is judged without a stringify crash', typeof fn({ outputSchema: z.object({ a: z.string() }) }, circular) === 'string' && fn({ outputSchema: z.object({ a: z.number() }) }, circular) === undefined)
  }
  const tool = probeTool('OutputSecret', z.object({ count: z.number() }), () => ({ count: 'the-secret-value-9f8e7d' }))
  const { results } = await run(tool)
  const records = await traceRecords()
  const mine = records.filter(r => r.tool === 'OutputSecret')
  check('the trace line carries the mark only, never the result\u2019s words', mine.length === 1 && mine[0]!.outputMismatch === true && !JSON.stringify(mine[0]).includes('the-secret-value'), j(mine))
  check('the control: the reply is the tool\u2019s own bytes', results[0]!.content === 'reply:{"count":"the-secret-value-9f8e7d"}', j(results))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
