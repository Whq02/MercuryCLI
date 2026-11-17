import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'input-transformations-log-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENAI_API_KEY', 'MERCURY_EFFORT_LEVEL']) delete process.env[key]
process.argv.push('--log-stderr')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const debugLines: string[] = []
const realWrite = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean
process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
  debugLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
  return realWrite(chunk, ...rest)
}) as typeof process.stderr.write

const wire = await import('../../src/services/providers/openai/openaiWire.js')
const { streamOneOpenaiAttempt } = await import('../../src/services/providers/openai/openaiCallModel.js')
import type { OpenaiStreamEvent } from '../../src/services/providers/openai/openaiWire.ts'

const model = 'gpt-6.2-astra'
const marker = '[openai] input_transformations on'
const withheld = [
  { id: 'rs_a', action: 'removed', reason: 'prefix_mismatch', type: 'reasoning' },
  { id: 'rs_b', action: 'removed', reason: 'turn_boundary', type: 'reasoning' },
]
const failures: string[] = []
let checks = 0
async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  checks++
  try { await run(); console.log(`PASS ${label}`) } catch (e) { failures.push(label); console.log(`FAIL ${label}: ${String(e)}`) }
}
function foldOf(response: Record<string, unknown>): OpenaiStreamEvent[] {
  const fold = new wire.ResponsesStreamFold()
  const events: OpenaiStreamEvent[] = []
  const payloads: unknown[] = [
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_fixture', delta: 'OK.' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK.', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp_fixture', model, usage: { input_tokens: 100, output_tokens: 2 }, ...response } },
  ]
  for (const payload of payloads) events.push(...fold.fold(payload))
  return events
}
function finishOf(events: OpenaiStreamEvent[]): Extract<OpenaiStreamEvent, { type: 'finish' }> | undefined {
  return events.find((event): event is Extract<OpenaiStreamEvent, { type: 'finish' }> => event.type === 'finish')
}
async function settle(events: OpenaiStreamEvent[], request: Record<string, unknown>): Promise<{ texts: string[]; notes: string[] }> {
  const notes: string[] = []
  const source = (async function* () { for (const event of events) yield event })()
  const turn = streamOneOpenaiAttempt({
    _eventsForTesting: source as never,
    request: request as never,
    auth: { baseUrl: 'https://unused.invalid', headers: {}, account: { kind: 'api-key', label: 'fixture source' } } as never,
    signal: new AbortController().signal,
    tools: [] as never,
    options: { querySource: 'sdk' } as never,
    modelId: model,
    messages: [] as never,
    settlementNotes: notes as never,
    contractDigest: 'prover-digest',
  })
  const texts: string[] = []
  let step = await turn.next()
  while (!step.done) {
    const value = step.value as { type: string; message?: { content?: Array<Record<string, unknown>> } }
    if (value.type === 'assistant') for (const block of value.message?.content ?? []) if (typeof block.text === 'string') texts.push(block.text)
    step = await turn.next()
  }
  return { texts, notes }
}
const linesWritten = (): string[] => debugLines.filter(line => line.includes(marker))
try {
  const dropped = foldOf({ input_transformations: withheld })
  await check("the fold reads the response's input_transformations: each withheld reasoning item with its reason", () => {
    assert.deepEqual(finishOf(dropped)?.inputTransformations, [
      { id: 'rs_a', action: 'removed', reason: 'prefix_mismatch' },
      { id: 'rs_b', action: 'removed', reason: 'turn_boundary' },
    ])
  })
  const request = { model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }], stream: true, store: false }
  const sent = JSON.stringify(request)
  const turn = await settle(dropped, request)
  await check('the road writes one debug line that names the model, the count, each item and why', () => {
    const lines = linesWritten()
    assert.equal(lines.length, 1, lines.join(''))
    const line = lines[0]!
    assert.ok(line.includes('[DEBUG]'), line)
    assert.ok(line.includes(`${marker} ${model}: the provider withheld 2 reasoning items of this request from the model (prefix_mismatch 1, turn_boundary 1): rs_a removed prefix_mismatch; rs_b removed turn_boundary`), line)
  })
  await check('nothing reaches the screen: the minted text is the answer alone and no settlement note is added', () => {
    assert.deepEqual(turn.texts, ['OK.'])
    assert.deepEqual(turn.notes, [])
  })
  await check('nothing changes in what is sent: the request is byte for byte what it was', () => {
    assert.equal(JSON.stringify(request), sent)
    assert.equal(sent.includes('input_transformations'), false)
  })
  await check('a response that withheld nothing writes no line', async () => {
    const plain = foldOf({})
    assert.equal(finishOf(plain)?.inputTransformations, undefined)
    const empty = foldOf({ input_transformations: [] })
    assert.equal(finishOf(empty)?.inputTransformations, undefined)
    await settle(plain, request)
    await settle(empty, request)
    assert.equal(linesWritten().length, 1)
  })
  await check('a row with no id or reason is read without a throw, and what is not a row is passed over', () => {
    assert.deepEqual(wire.readInputTransformations({ input_transformations: [{}, 'x', null, { id: 7, reason: 'model_mismatch' }] }), [
      { id: 'unnamed', action: 'removed', reason: 'unstated' },
      { id: 'unnamed', action: 'removed', reason: 'model_mismatch' },
    ])
    assert.deepEqual(wire.readInputTransformations(undefined), [])
  })
  await check('one withheld item is counted in the singular', () => {
    assert.ok(wire.inputTransformationsLine(model, [{ id: 'rs_a', action: 'removed', reason: 'end_user_mismatch' }]).includes('withheld 1 reasoning item of this request'))
  })
} finally {
  process.stderr.write = realWrite as typeof process.stderr.write
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; the field read 2026-11-17: https://developers.openai.com/api/reference/resources/responses/methods/create; https://developers.openai.com/api/docs/guides/reasoning`)
process.exit(failures.length ? 1 : 0)
