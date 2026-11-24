import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { renderTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'

export type Json = Record<string, unknown>
export type Step = { name: string; input: Json } | { say: string }
export type Seen = { n: number; prompt: string; arrivedMs: number; answeredMs: number; wireBytes: number; body: Json }
export type Road = {
  name: string
  model: string
  env: (base: string) => Record<string, string>
  list: (url: string) => unknown
  isTurn: (url: string) => boolean
  answer: (step: Step, n: number) => string
  head: (body: Json) => Array<[string, unknown]>
  rows: (body: Json) => unknown[]
  toolNames: (body: Json) => string[]
}
export type Repeat = { headBytes: number; cacheBytes: number; sharedBytes: number; lostBytes: number; brokeAt: string; moved: string; toolsGrew: boolean }
export type RoadServer = { base: string; seen: Seen[]; sides: () => number; close: () => Promise<void> }

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
const named = (tools: unknown): string[] => list(tools).map(tool => String((tool as Json).name ?? (tool as Json).type ?? ''))

function withoutCacheMarks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarks)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, inner]) => [key, withoutCacheMarks(inner)]))
}

export const roads: Road[] = [
  {
    name: 'anthropic',
    model: 'claude-opus-4-8',
    env: base => ({ ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: `${base}/anthropic`, MERCURY_TOOL_SEARCH: 'on' }),
    list: url => (url.endsWith('/models') ? { data: [{ type: 'model', id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-08-01T00:00:00Z' }], has_more: false } : url.includes('count_tokens') ? { input_tokens: 1000 } : undefined),
    isTurn: url => url.endsWith('/messages'),
    answer: (step, n) => renderTurn('say' in step ? { kind: 'text', text: step.say } : { kind: 'tool_use', name: step.name, input: step.input, id: `toolu_cost_${n}` }, n),
    head: body => [['tools', withoutCacheMarks(list(body.tools).filter(tool => (tool as Json).defer_loading !== true))], ['system', withoutCacheMarks(body.system)]],
    rows: body => list(withoutCacheMarks(body.messages)),
    toolNames: body => named(list(body.tools).filter(tool => (tool as Json).defer_loading !== true)),
  },
  {
    name: 'openai',
    model: 'gpt-5.6-sol',
    env: base => ({ OPENAI_API_KEY: 'fixture-openai-key', MERCURY_OPENAI_API_BASE: `${base}/openai/v1` }),
    list: url => (url.endsWith('/models') ? { data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] } : undefined),
    isTurn: url => url.endsWith('/responses'),
    answer: (step, n) => {
      const item = 'say' in step
        ? { type: 'message', id: `msg_${n}`, role: 'assistant', content: [{ type: 'output_text', text: step.say }] }
        : { type: 'function_call', id: `fc_${n}`, call_id: `call_cost_${n}`, name: step.name, arguments: JSON.stringify(step.input) }
      return [
        sse({ type: 'response.created', response: { id: `resp_${n}` } }),
        sse({ type: 'response.output_item.added', item: 'say' in step ? { ...item, content: [] } : { ...item, arguments: '' } }),
        'say' in step ? sse({ type: 'response.output_text.delta', delta: step.say }) : sse({ type: 'response.function_call_arguments.delta', item_id: `fc_${n}`, delta: JSON.stringify(step.input) }),
        sse({ type: 'response.output_item.done', item }),
        sse({ type: 'response.completed', response: { id: `resp_${n}`, usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } } }),
      ].join('')
    },
    head: body => [['instructions', body.instructions], ['tools', body.tools]],
    rows: body => list(body.input),
    toolNames: body => named(body.tools),
  },
  {
    name: 'google',
    model: 'gemini-3.5-flash',
    env: base => ({ GEMINI_API_KEY: 'fixture-gemini-key', MERCURY_GEMINI_API_BASE: `${base}/v1beta` }),
    list: url => (url.endsWith('/models') ? { models: [{ name: 'models/gemini-3.5-flash', displayName: 'Gemini fixture', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000, outputTokenLimit: 65536 }] } : undefined),
    isTurn: url => url.endsWith(':streamGenerateContent'),
    answer: (step, n) =>
      sse({ candidates: [{ index: 0, content: { role: 'model', parts: ['say' in step ? { text: step.say } : { functionCall: { name: step.name, args: step.input, id: `call_cost_${n}` } }] } }] }) +
      sse({ candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 } }),
    head: body => [['systemInstruction', body.systemInstruction], ['tools', body.tools]],
    rows: body => list(body.contents),
    toolNames: body => list(body.tools).flatMap(group => named((group as Json).functionDeclarations)),
  },
]

function sharedLength(before: Buffer, after: Buffer): number {
  const limit = Math.min(before.length, after.length)
  let at = 0
  while (at < limit && before[at] === after[at]) at++
  return at
}

function cacheOrder(road: Road, body: Json): { text: Buffer; headBytes: number; marks: Array<{ label: string; end: number }> } {
  const marks: Array<{ label: string; end: number }> = []
  let text = ''
  for (const [label, value] of road.head(body)) {
    text += `${JSON.stringify(value ?? null)}\n`
    marks.push({ label, end: bytes(text) })
  }
  const headBytes = bytes(text)
  road.rows(body).forEach((row, index) => {
    text += `${JSON.stringify(row)}\n`
    marks.push({ label: `conversation[${index}]`, end: bytes(text) })
  })
  return { text: Buffer.from(text, 'utf8'), headBytes, marks }
}

export function repeatOf(road: Road, before: Seen | undefined, row: Seen): Repeat {
  const now = cacheOrder(road, row.body)
  if (before === undefined) return { headBytes: now.headBytes, cacheBytes: now.text.length, sharedBytes: 0, lostBytes: 0, brokeAt: '', moved: '', toolsGrew: false }
  const earlier = cacheOrder(road, before.body)
  const sharedBytes = sharedLength(earlier.text, now.text)
  const lostBytes = earlier.text.length - sharedBytes
  const held = new Set(['messages', 'input', 'contents', ...road.head(row.body).map(([label]) => label)])
  const moved = [...new Set([...Object.keys(before.body), ...Object.keys(row.body)])].filter(key => !held.has(key) && JSON.stringify(before.body[key]) !== JSON.stringify(row.body[key]))
  const toolsBefore = road.toolNames(before.body)
  const toolsNow = road.toolNames(row.body)
  return {
    toolsGrew: toolsNow.length > toolsBefore.length && toolsBefore.every((name, index) => toolsNow[index] === name),
    headBytes: now.headBytes,
    cacheBytes: now.text.length,
    sharedBytes,
    lostBytes,
    brokeAt: lostBytes === 0 ? '' : earlier.marks.find(mark => mark.end > sharedBytes)?.label ?? 'end',
    moved: moved.join(','),
  }
}

export function writeProject(work: string, weight: number): void {
  mkdirSync(join(work, 'src'), { recursive: true })
  mkdirSync(join(work, 'test'), { recursive: true })
  writeFileSync(join(work, 'package.json'), '{"name":"turn-cost","type":"module","scripts":{"test":"node --test"}}\n')
  writeFileSync(join(work, 'src', 'sum.js'), 'export function sum(a, b) {\n  return a - b\n}\n')
  writeFileSync(join(work, 'test', 'sum.test.js'), "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { sum } from '../src/sum.js'\n\ntest('sum adds', () => {\n  assert.equal(sum(2, 3), 5)\n})\n")
  if (weight > 0) mkdirSync(join(work, 'docs'), { recursive: true })
  for (let index = 0; index < weight; index++) {
    writeFileSync(join(work, 'docs', `part-${index}.md`), Array.from({ length: 900 }, (_, line) => `part ${index} line ${line}: ${'the quick brown fox jumps over the lazy dog '.repeat(2)}`).join('\n'))
  }
}

export async function serveRoad(road: Road, next: (body: Json) => { prompt: string; step: Step } | undefined, clock: () => number, onSide?: (body: Json, n: number) => void): Promise<RoadServer> {
  const seen: Seen[] = []
  let sides = 0
  const api = createServer(async (request, response) => {
    const arrivedMs = clock()
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    const url = (request.url ?? '').split('?')[0] ?? ''
    const listed = road.list(url)
    if (listed !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(listed))
      return
    }
    if (request.method !== 'POST' || !road.isTurn(url)) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    const body = JSON.parse(raw.toString('utf8')) as Json
    const scripted = list(body.tools).length === 0 ? undefined : next(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (scripted === undefined) {
      sides++
      onSide?.(body, sides)
      response.end(road.answer({ say: 'A side answer.' }, 900 + sides))
      return
    }
    const row: Seen = { n: seen.length + 1, prompt: scripted.prompt, arrivedMs, answeredMs: 0, wireBytes: raw.length, body }
    seen.push(row)
    response.end(road.answer(scripted.step, row.n), () => { row.answeredMs = clock() })
  })
  await new Promise<void>(done => api.listen(0, '127.0.0.1', done))
  const address = api.address()
  return {
    base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    seen,
    sides: () => sides,
    close: () => new Promise<void>(done => api.close(() => done())),
  }
}
