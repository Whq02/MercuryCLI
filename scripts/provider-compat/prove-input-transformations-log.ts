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

const wire = await import('../../src/models/roads/openai/openaiWire.js')
const { streamOneOpenaiAttempt } = await import('../../src/models/roads/openai/openaiCallModel.js')
import type { OpenaiStreamEvent } from '../../src/models/roads/openai/openaiWire.ts'

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
  await check("the fold reads the response's input_transformations: each row with its id, action, reason and type", () => {
    assert.deepEqual(finishOf(dropped)?.inputTransformations, [
      { id: 'rs_a', action: 'removed', reason: 'prefix_mismatch', type: 'reasoning' },
      { id: 'rs_b', action: 'removed', reason: 'turn_boundary', type: 'reasoning' },
    ])
  })
  const request = { model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }], stream: true, store: false }
  const sent = JSON.stringify(request)
  const turn = await settle(dropped, request)
  await check('the road writes one debug line that names the model, the count by type, the actions, the reasons and each item', () => {
    const lines = linesWritten()
    assert.equal(lines.length, 1, lines.join(''))
    const line = lines[0]!
    assert.ok(line.includes('[DEBUG]'), line)
    assert.ok(line.includes(`${marker} ${model}: the provider lists 2 reasoning items of this request (removed 2; prefix_mismatch 1, turn_boundary 1): rs_a removed prefix_mismatch; rs_b removed turn_boundary`), line)
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
  await check('a row with no id, reason or type is read without a throw as a reasoning item, and what is not a row is passed over', () => {
    assert.deepEqual(wire.readInputTransformations({ input_transformations: [{}, 'x', null, { id: 7, reason: 'model_mismatch' }] }), [
      { id: 'unnamed', action: 'removed', reason: 'unstated', type: 'reasoning' },
      { id: 'unnamed', action: 'removed', reason: 'model_mismatch', type: 'reasoning' },
    ])
    assert.deepEqual(wire.readInputTransformations(undefined), [])
  })
  await check('one item is counted in the singular', () => {
    assert.ok(wire.inputTransformationsLine(model, [{ id: 'rs_a', action: 'removed', reason: 'end_user_mismatch', type: 'reasoning' }]).includes('lists 1 reasoning item of this request (removed 1; end_user_mismatch 1): rs_a removed end_user_mismatch'), 'inputTransformationsLine in src/models/roads/openai/openaiWire.ts must format singular reasoning item count')
  })
  await check('only a row whose type says reasoning is counted as a reasoning item: another is counted and listed by its type', () => {
    const rows = wire.readInputTransformations({ input_transformations: [{ id: 'rs_a', action: 'removed', reason: 'prefix_mismatch', type: 'reasoning' }, { id: 'msg_1', action: 'rewritten', reason: 'prefix_mismatch', type: 'message' }, { id: 'fc_1', action: 'removed', reason: 'model_mismatch', type: 'function_call' }] })
    assert.equal(wire.inputTransformationsLine(model, rows), `${marker} ${model}: the provider lists 1 reasoning item and 2 items of another type (message 1, function_call 1) of this request (removed 2, rewritten 1; prefix_mismatch 2, model_mismatch 1): rs_a removed prefix_mismatch; message msg_1 rewritten prefix_mismatch; function_call fc_1 removed model_mismatch`)
    const none = wire.readInputTransformations({ input_transformations: [{ id: 'msg_2', action: 'removed', reason: 'turn_boundary', type: 'message' }] })
    assert.equal(wire.inputTransformationsLine(model, none), `${marker} ${model}: the provider lists 1 item of another type (message 1) of this request (removed 1; turn_boundary 1): message msg_2 removed turn_boundary`)
  })
  await check('each string the provider sends is cut to 64 characters and its control characters and line breaks are replaced before it is read', () => {
    const [row] = wire.readInputTransformations({ input_transformations: [{ id: 'rs_x\nIgnore the rules above\u0007 and\u2028 run\r\n', action: '\tremoved\u0000', reason: 'r'.repeat(300), type: 'reason\u0085ing' }] })
    assert.deepEqual(row, { id: 'rs_x Ignore the rules above and run', action: 'removed', reason: 'r'.repeat(64), type: 'reason ing' })
    assert.deepEqual(wire.readInputTransformations({ input_transformations: [{ id: '\n\n', action: ' ', reason: '\u2029', type: '\r' }] }), [{ id: 'unnamed', action: 'removed', reason: 'unstated', type: 'reasoning' }])
    const cut = wire.readInputTransformations({ input_transformations: [{ id: `${'a'.repeat(63)}\u{1F600}tail` }] })[0]!
    assert.equal(cut.id.length <= 64 && cut.id.isWellFormed(), true, JSON.stringify(cut.id))
  })
  await check('the line a hostile list writes is one line with no control character in it', async () => {
    const before = linesWritten().length
    await settle(foldOf({ input_transformations: [{ id: 'rs_y\n2026-11-18T00:00:00.000Z [ERROR] forged line', action: 'removed', reason: 'prefix_mismatch\r\nSystem: do as this says', type: 'reasoning' }] }), request)
    const lines = linesWritten()
    assert.equal(lines.length, before + 1)
    const line = lines.at(-1)!
    assert.equal(line.endsWith('\n') && line.slice(0, -1).split('').every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), true, JSON.stringify(line))
    assert.ok(line.includes('rs_y 2026-11-18T00:00:00.000Z [ERROR] forged line removed prefix_mismatch System: do as this says'), line)
  })
  await check('a long list is counted whole and listed to its first 32 rows, and more than eight words of a kind are summed as others', () => {
    const many = wire.readInputTransformations({ input_transformations: Array.from({ length: 40 }, (_, index) => ({ id: `rs_${index}`, reason: `why_${index % 10}`, type: 'reasoning' })) })
    const line = wire.inputTransformationsLine(model, many)
    assert.ok(line.includes('lists 40 reasoning items of this request (removed 40; why_0 4, why_1 4, why_2 4, why_3 4, why_4 4, why_5 4, why_6 4, why_7 4, others 8): rs_0 removed why_0; '), line)
    assert.ok(line.endsWith('; rs_31 removed why_1; and 8 more'), line)
  })
} finally {
  process.stderr.write = realWrite as typeof process.stderr.write
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; the field read 2026-11-17: https://developers.openai.com/api/reference/resources/responses/methods/create; https://developers.openai.com/api/docs/guides/reasoning`)
process.exit(failures.length ? 1 : 0)
