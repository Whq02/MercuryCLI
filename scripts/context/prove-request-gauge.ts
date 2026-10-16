import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { buildRequestContextPlan, reconcileAppliedPlanUsage } = await import('../../src/services/run/requestContextPlan.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const { calibrationFor, resetCalibration } = await import('../../src/services/run/contextCalibration.js')
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId: 'request-gauge', lane: 'main' })
const key = 'gemini:fixture:c1'
resetCalibration()
for (let n = 0; n < 40; n++) {
  await buildRequestContextPlan({
    messages: [{ type: 'user', uuid: 'request', message: { role: 'user', content: 'x'.repeat(4000) } }] as never,
    owner, querySource: 'main_thread', skipToolNames: new Set(), contentReplacementState: undefined,
    calibrationKey: key,
    microcompact: async messages => ({ messages }),
  }, 'apply')
  reconcileAppliedPlanUsage(owner, 2000)
}
const density = calibrationFor(key)
console.log('stationary density', density)
assert.ok(density.calibrated && Math.abs(density.ratio - 2) < 0.001, 'measured / unscaled denominator converges to 2, not 1.414')
console.log('PASS request-view calibration denominator')

const gauge = await import('../../src/services/run/requestGauge.js')
const { contextFill, tokenCountWithEstimation } = await import('../../src/utils/tokens.js')
const { roughTokenCountEstimationForMessages } = await import('../../src/services/tokenEstimation.js')
const { entryToRecord, recordToEntry } = await import('../../src/fabric/entryCodec.js')
const { asSessionId } = await import('../../src/types/ids.js')
const { nextOrdinal } = await import('../../src/fabric/ordinal.js')
type Message = import('../../src/types/message.js').Message
type Assistant = import('../../src/types/message.js').AssistantMessage
const user = (id: string, content: unknown): Message => ({ type: 'user', uuid: id, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content } }) as Message
const answer = (id: string, input: number, output = 100): Assistant => ({
  type: 'assistant', uuid: id, timestamp: '2026-01-01T00:00:00Z', message: {
    id, model: 'fixture', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }, requestId: id,
}) as Assistant
const fixed = gauge.requestGaugeFixed({ system: 's'.repeat(72000), tools: [{ name: 'Read', input_schema: { type: 'object' } }] })
const requestKey = 'gemini:fixture:c1'
const history = [user('initial', '目标 héllo 😀 '.repeat(40)), user('read', [{ type: 'tool_result', tool_use_id: 'read', content: 'body'.repeat(10000) }])]
const cold = gauge.bindRequestGauge(history, requestKey, 0, fixed)
assert.equal(cold.tokens, fixed.tokens + roughTokenCountEstimationForMessages(history))
assert.equal(cold.transition, 'cold')
const first = answer('first', 30000)
assert.ok(gauge.settleRequestGauge(cold, first))
const result = user('result', [{ type: 'tool_result', tool_use_id: 'next', content: 'data'.repeat(2000) }])
const next = [...history, first, result]
const view = gauge.bindRequestGauge(next, requestKey, 0, fixed)
assert.equal(view.tokens, 32100)
assert.equal(contextFill(next, 'fixture').tokens, tokenCountWithEstimation(next, 'fixture'))
assert.equal(contextFill(next, 'fixture').tokens, view.tokens)
const second = answer('second', 34100)
gauge.settleRequestGauge(view, second)
assert.ok(Math.abs(second.contextGauge!.density.ratio - 1.2) < 1e-10)
assert.equal(second.contextGauge?.sample.denominator, 2000)
assert.equal(second.contextGauge?.sample.measured, 4000)
const restarted = JSON.parse(JSON.stringify([...next, second])) as Message[]
assert.equal(contextFill(restarted, 'fixture').tokens, 34200)
const sibling = { ...second, uuid: 'sibling', message: { ...second.message, content: [{ type: 'text', text: 'x'.repeat(16000) }] } } as Assistant
assert.equal(contextFill([...next, sibling, second], 'fixture').tokens, 34200)
const pruned = [history[0]!, user('read', '[result stored elsewhere]'), first, result, second]
const projected = gauge.bindRequestGauge(pruned, requestKey, 1, fixed)
assert.equal(projected.transition, 'rebased')
assert.equal(projected.source, 'estimate')
assert.equal(projected.tokens, Math.ceil(fixed.tokens + roughTokenCountEstimationForMessages(pruned) * 1.2))
assert.equal(contextFill(pruned, 'fixture').tokens, projected.tokens)
assert.notEqual(projected.tokens, 34200)
assert.equal(gauge.readRequestGauge(pruned, 'other-family-model'), null)
const media = [user('media', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(100000) } }])]
assert.equal(gauge.bindRequestGauge(media, requestKey, 0, fixed).tokens, fixed.tokens + 2000)
const attachment = { type: 'attachment', uuid: 'attached', attachment: { type: 'compact_file_reference', filename: 'source.ts', content: 'file contents' } } as unknown as Message
assert.ok(roughTokenCountEstimationForMessages([attachment]) > 0, 'attachment is counted through its renderer')
const recorded = entryToRecord(second as never, { sessionId: asSessionId('gauge'), nextOrdinal: () => nextOrdinal(null), observedAt: second.timestamp, source: { kind: 'test' } } as never)
assert.deepEqual(recordToEntry(recorded).contextGauge, second.contextGauge)
console.log('PASS cold fixed material, independent tail learning, sibling streaming, restart, media, attachment, projected prune, route isolation and record round trip')

const oldResponse = answer('unstamped', 150000)
const oldHistory = [...history, oldResponse]
assert.equal(gauge.bindRequestGauge(oldHistory, requestKey, 0, fixed).tokens, 150100)
assert.equal(gauge.bindRequestGauge(oldHistory, requestKey, 1, fixed, true).source, 'estimate')
console.log('PASS an unstamped settled input survives restart until an explicit projection rebases it')
