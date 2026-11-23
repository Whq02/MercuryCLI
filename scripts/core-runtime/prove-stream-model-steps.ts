#!/usr/bin/env bun
import * as t from './turnScenarios.ts'

const { makeRequest } = await import('../../src/engine/loop/turn/makeRequest.ts')
const stream = await import('../../src/engine/loop/turn/streamModel.ts')
const { operatorPauseGate } = await import('../../src/engine/loop/pauseGate.ts')
const { engineLadderOf } = await import('../../src/engine/requests/backupEngines.ts')
const { FallbackTriggeredError } = await import('../../src/engine/requests/withRetry.ts')
const { ImageSizeError } = await import('../../src/engine/requests/imageValidation.ts')
const { createAssistantAPIErrorMessage } = await import('../../src/engine/messages/messages.ts')

const f = t.fixtures
type Row = Record<string, unknown>
type Events = Array<Row & { kind: string }>
type Plan = Parameters<typeof t.plantRun>[0]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) console.log(`    where: ${new Error().stack?.split('\n')[2]?.trim() ?? 'this file'}; change the stream.<step> function this check's section calls in src/engine/loop/turn/streamModel.ts so the condition holds`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the model call steps exceeded 180s; a step in src/engine/loop/turn/streamModel.ts never settled, find the last section printed above')
  process.exit(1)
}, 180_000)
guard.unref?.()

const kinds = (events: Events): string => events.map(event => event.kind).join(',')
const j = (value: unknown): string => JSON.stringify(value)

async function before(plan: Plan, state: Row = {}) {
  const planted = await t.plantRun(plan)
  Object.assign(planted.state, state)
  const made = await t.drain(makeRequest(planted.run as never, planted.state as never, 1))
  if (made.decision.kind !== 'go_on') throw new Error(`the planted request did not go on: ${t.reasonOf(made.decision)}; makeRequest in src/engine/loop/turn/makeRequest.ts refused the plan, or the plan in this file is wrong`)
  const iter = made.decision.iter as unknown as Row
  const emit = planted.run.emit as never
  return { planted, iter, emit, run: planted.run as never, it: iter as never }
}
const settlingFor = (callId: string): Row & { gauged: unknown[] } => {
  const gauged: unknown[] = []
  return { callId, projectedReplies: new Map(), settleGauge: (message: unknown) => void gauged.push(message), fixedPrefix: undefined, gauged }
}

console.log('============================================================')
console.log(' one model call, part by part: src/engine/loop/turn/streamModel.ts')
console.log('============================================================')

section('(1) waiting for the gate and the permit')
{
  const p = await before({ script: [] })
  const out = await t.drain(stream.waitForModelPermit(p.run, p.it, p.emit))
  check('a call is named after its turn and its place in it, and its permit is announced once', out.decision?.callId === 't1.c1' && typeof out.decision.permitKey === 'string' && out.decision.permitKey.endsWith(':t1.c1') && kinds(out.events) === 'model_permit' && out.events[0]?.callId === 't1.c1' && p.iter.callOrdinal === 1, `${j(out.decision)} · ${kinds(out.events)}`)
  const again = await t.drain(stream.waitForModelPermit(p.run, p.it, p.emit))
  check('a second call of the same turn is the next place', again.decision?.callId === 't1.c2', j(again.decision))
  p.planted.close()

  const held = await before({ seatWait: true, script: [] })
  operatorPauseGate.pause()
  const timer = setTimeout(() => held.planted.rig.abortController.abort(), 20)
  const parked = await t.drain(stream.waitForModelPermit(held.run, held.it, held.emit))
  clearTimeout(timer)
  operatorPauseGate.resume()
  check('a run aborted while the operator holds it gets no permit and no call: nothing is yielded', parked.decision === null && parked.events.length === 0 && held.iter.callOrdinal === 0, `${j(parked.decision)} · ${kinds(parked.events)}`)
  held.planted.close()
}

section('(2) announcing the call')
{
  const p = await before({ script: [] })
  const out = await t.drain(stream.announceModelCall(p.it, p.emit, 't1.c1'))
  const started = out.events[0]
  check('the call is announced with its model, its effort and the reference the provider will be held to', kinds(out.events) === 'model_call_started' && started?.callId === 't1.c1' && started.model === t.MODEL && started.effort === 'high' && out.decision.effortValue === 'high' && started.reference === out.decision.callReference, `${kinds(out.events)} · ${j({ model: started?.model, effort: started?.effort })}`)
  p.planted.close()

  const other = f.says('an answer from the other model')
  ;(other.message as unknown as Row).content = [{ type: 'thinking', thinking: 'a thought from the other model', signature: 'rig-signature' }, { type: 'text', text: 'an answer from the other model' }]
  other.message.model = t.FALLBACK_MODEL
  const switched = await before({ seed: [f.ask('an old question'), other, f.ask('hello there rig')], script: [] })
  const first = await t.drain(stream.announceModelCall(switched.it, switched.emit, 't1.c1'))
  const second = await t.drain(stream.announceModelCall(switched.it, switched.emit, 't1.c2'))
  check("after a switch of models the thinking the other model wrote is said to stay out, once for that history", kinds(first.events) === 'model_call_started,notice' && t.noticesOf(first.events)[0]!.startsWith('Preserved thinking: 1 thinking block') && kinds(second.events) === 'model_call_started', `${kinds(first.events)} · ${kinds(second.events)}`)
  switched.planted.close()
}

section('(3) one stream of one call')
{
  const call = (p: Awaited<ReturnType<typeof before>>, callId = 't1.c1'): Row => ({ callId, effortValue: 'high', callReference: { rig: true }, streamController: new AbortController() })
  const p = await before({ script: [[...f.yields({ type: 'stream_event', event: { type: 'ping' } }, f.says('done.'))]] })
  const ladder = engineLadderOf(p.run, undefined)
  const out = await t.drain(stream.streamOneCall(p.run, p.it, p.emit, call(p) as never, ladder))
  const request = p.planted.requests[0]
  check('a delta is passed on as it comes and a reply is settled under the call', kinds(out.events) === 'stream_delta,assistant_settled' && out.events.every(event => event.callId === 't1.c1') && (p.iter.assistantMessages as unknown[]).length === 1, kinds(out.events))
  check('the provider is handed the model, the effort, the reference and the chain of the call, and the roster owner as its key', request?.options.model === t.MODEL && request.options.effortValue === 'high' && j(request.options.callReference) === j({ rig: true }) && request.options.callChain === p.iter.callChain && typeof request.options.ownerKey === 'string' && request.options.toolChoice === undefined, j({ model: request?.options.model, effort: request?.options.effortValue }))
  p.planted.close()

  const closing = await before({ maxTurns: 1, script: [f.yields(f.says('closing words'))] }, { turnCount: 2 })
  await t.drain(stream.streamOneCall(closing.run, closing.it, closing.emit, call(closing) as never, engineLadderOf(closing.run, undefined)))
  check('on the closing turn the provider is told to call no tool, with the tools still on the wire', j(closing.planted.requests[0]?.options.toolChoice) === j({ type: 'none' }) && closing.planted.requests[0]?.tools.length === 1, j(closing.planted.requests[0]?.options.toolChoice))
  closing.planted.close()

  const swapped = await before({ script: [[...f.yields(f.says('partial from the failing model')), { kind: 'do', fn: env => (env.options.onStreamingFallback as () => void)() }, ...f.yields(f.says('fresh from the fallback'))]] })
  const retried = await t.drain(stream.streamOneCall(swapped.run, swapped.it, swapped.emit, call(swapped) as never, engineLadderOf(swapped.run, undefined)))
  check('when the provider falls back mid-stream what had settled is taken back before the fresh reply settles', kinds(retried.events) === 'assistant_settled,assistant_retracted,assistant_settled' && (swapped.iter.assistantMessages as unknown[]).length === 1, kinds(retried.events))
  swapped.planted.close()
}

section('(4) settling one reply')
{
  const p = await before({ script: [] })
  const toolCall = f.calls('tu_1', 'EchoTool', { text: 'x' })
  const settling = settlingFor('t1.c1')
  const out = await t.drain(stream.settleReply(p.run, p.it, p.emit, settling as never, toolCall as never, toolCall as never))
  check('a reply that calls a tool is settled, measured, and its call kept for the tool step', kinds(out.events) === 'assistant_settled' && out.events[0]?.withheld === false && settling.gauged.length === 1 && p.iter.needsFollowUp === true && j((p.iter.toolUseBlocks as Row[]).map(block => block.id)) === j(['tu_1']) && (p.iter.assistantMessages as unknown[]).length === 1, `${kinds(out.events)} · gauged ${settling.gauged.length}`)

  const cut = f.outputCut()
  const held = await t.drain(stream.settleReply(p.run, p.it, p.emit, settlingFor('t1.c1') as never, cut as never, cut as never))
  check('a reply cut at the output ceiling is settled as held back, for the rules to judge', held.events[0]?.kind === 'assistant_settled' && held.events[0].withheld === true, j(held.events[0]?.withheld))

  const waited = f.says('the answer after the wait.')
  ;(waited as unknown as Row).busyRecovery = { provider: 'Anthropic', retries: 2, elapsedMs: 1_200, detail: 'overloaded, retried twice', status: 529 }
  const once = await t.drain(stream.settleReply(p.run, p.it, p.emit, settlingFor('t1.c1') as never, waited as never, waited as never))
  const twice = await t.drain(stream.settleReply(p.run, p.it, p.emit, settlingFor('t1.c1') as never, waited as never, waited as never))
  check('a reply that came after a busy provider carries one receipt of the wait, given once for that reply', kinds(once.events) === 'notice,assistant_settled' && kinds(twice.events) === 'assistant_settled', `${kinds(once.events)} · ${kinds(twice.events)}`)
  p.planted.close()
}

section('(5) thinking the API dropped')
{
  const p = await before({ script: [] })
  const reply = f.says('the answer, with one old thought left out.')
  ;(reply.message as unknown as Row).input_transformations = [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'signature_invalid' }]
  const settling = settlingFor('t1.c1')
  const first = await t.drain(stream.classifyDroppedThinking(p.run, p.it, p.emit, settling as never, reply as never))
  const second = await t.drain(stream.classifyDroppedThinking(p.run, p.it, p.emit, settling as never, reply as never))
  check('a reply the API answered after dropping a thinking block says so in one row, and a response is judged once', kinds(first.events) === 'notice' && t.noticesOf(first.events)[0]!.startsWith('Preserved thinking: the API dropped 1 thinking block') && second.events.length === 0, `${j(t.noticesOf(first.events))} · ${kinds(second.events)}`.slice(0, 300))
  const plain = await t.drain(stream.classifyDroppedThinking(p.run, p.it, p.emit, settlingFor('t1.c1') as never, f.says('nothing dropped.') as never))
  check('a reply with nothing dropped yields nothing', plain.events.length === 0, kinds(plain.events))
  p.planted.close()
}

section('(6) the receipts after the stream')
{
  const p = await before({ script: [] })
  const quiet = f.says('the reply that stands.')
  ;(quiet as unknown as Row).streamEnd = { reason: 'silent-after-last-item', provider: 'OpenAI', silentMs: 45_000 }
  ;(p.iter.assistantMessages as unknown[]).push(quiet)
  const gauged: unknown[] = []
  const first = await t.drain(stream.streamReceipts(p.it, p.emit, message => void gauged.push(message)))
  const second = await t.drain(stream.streamReceipts(p.it, p.emit, () => {}))
  check('a stream that went silent after its last item is receipted once for that reply, and every settled reply is measured', kinds(first.events) === 'notice' && t.noticesOf(first.events)[0]!.includes('went silent 45 s') && second.events.length === 0 && gauged.length === 1, `${j(t.noticesOf(first.events))} · ${kinds(second.events)}`)
  p.planted.close()
}

section('(7) a model call that failed')
{
  const p = await before({ script: [] })
  ;(p.iter.assistantMessages as unknown[]).push(f.calls('tu_err', 'EchoTool', { text: 'x' }))
  const boom = new Error('rig boom')
  const out = await t.drain(stream.modelCallFailed(p.it, p.emit, boom))
  check('an error ends the call as model_error carrying the error: the announced tool call settled as an error, then the error row', j(out.decision) === j({ kind: 'terminal', terminal: { reason: 'model_error', error: {} } }) && (out.decision as Row & { terminal: Row }).terminal.error === boom && kinds(out.events) === 'tool_settled,notice' && out.events[0]?.outcome === 'error' && out.events[0].synthetic === true, `${kinds(out.events)} · ${j(out.decision)}`)
  const image = await t.drain(stream.modelCallFailed(p.it, p.emit, new ImageSizeError([{ index: 0, size: 9_999_999 }] as never, 5_000_000)))
  check('an image the provider cannot take ends the call as image_error with one row and no settlement', j(image.decision) === j({ kind: 'terminal', terminal: { reason: 'image_error' } }) && kinds(image.events) === 'notice', `${kinds(image.events)} · ${j(image.decision)}`)
  p.planted.close()
}

section('(8) the whole call: streamModel')
{
  const p = await before({ fallbackModel: t.FALLBACK_MODEL, script: [[...f.yields(f.calls('tu_fb', 'EchoTool', { text: 'x' })), { kind: 'throw', error: new FallbackTriggeredError(t.MODEL, t.FALLBACK_MODEL) }], f.yields(f.says('recovered on fallback'))] })
  const out = await t.drain(stream.streamModel(p.run, p.it, p.emit))
  check('an overloaded engine with a backup is asked again on the backup: two calls under one turn, the first reply settled as an error, the switch said', j(out.decision) === j({ kind: 'streamed' }) && p.planted.requests.length === 2 && p.planted.requests[1]?.options.model === t.FALLBACK_MODEL && p.iter.currentModel === t.FALLBACK_MODEL && j(out.events.filter(event => event.kind === 'model_call_started').map(event => event.callId)) === j(['t1.c1', 't1.c2']) && out.events.some(event => event.kind === 'tool_settled' && event.synthetic === true), `${kinds(out.events)} · ${p.planted.requests.length} calls`)
  p.planted.close()

  const bare = await before({ script: [[...f.yields(f.calls('tu_fb', 'EchoTool', { text: 'x' })), { kind: 'throw', error: new FallbackTriggeredError(t.MODEL, t.FALLBACK_MODEL) }]] })
  const ended = await t.drain(stream.streamModel(bare.run, bare.it, bare.emit))
  check('with no backup the same failure ends the call as model_error', (ended.decision as Row).kind === 'terminal' && ((ended.decision as Row).terminal as Row).reason === 'model_error' && bare.planted.requests.length === 1, j((ended.decision as Row).kind))
  bare.planted.close()

  const failing = await before({ script: [f.yields(createAssistantAPIErrorMessage({ content: 'API Error: 500 upstream' }))] })
  const answered = await t.drain(stream.streamModel(failing.run, failing.it, failing.emit))
  check('an API error that arrives as a reply is settled like a reply: the call itself did not fail', j(answered.decision) === j({ kind: 'streamed' }) && kinds(answered.events) === 'model_permit,model_call_started,assistant_settled', kinds(answered.events))
  failing.planted.close()
}

console.log('')
console.log(failures === 0 ? `prove-stream-model-steps: ALL HOLD — ${checks} checks` : `prove-stream-model-steps: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
