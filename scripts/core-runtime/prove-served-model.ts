#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'served-model-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.NODE_ENV
delete process.env.MERCURY_DISABLE_NONSTREAMING_FALLBACK
delete process.env.MERCURY_EFFORT_LEVEL
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const ledger = await import('../../src/cost-tracker.ts')
const pulse = await import('../../src/utils/pulse/turnPhase.ts')
const { composePhaseByline } = await import('../../src/components/Spinner/pulseByline.ts')
const { getCanonicalName, getPublicModelDisplayName } = await import('../../src/utils/model/model.ts')

const REQUESTED = 'claude-fable-5-1'
const OTHER_FAMILY = 'claude-opus-5'
const DATED_TWIN = 'claude-fable-5-1-20260901'
const WIDE = 200

type Usage = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }
const USAGE: Usage = { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const framesServedBy = (model: string): string[] => [
  sse('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: USAGE } }),
  sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the fixture answer' } }),
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...USAGE, output_tokens: 40 } }),
  sse('message_stop', { type: 'message_stop' }),
]

type Wire = { requests: number; requestedModels: string[] }
function fixtureFetch(frames: string[], wire: Wire): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    wire.requests++
    const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {}
    wire.requestedModels.push(String(body.model ?? ''))
    const encoder = new TextEncoder()
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    })
    return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture_stream' } })
  }) as unknown as typeof fetch
}

type Yielded = { type?: string; message?: { model?: string } }
type Row = ReturnType<typeof ledger.getUsageForModel>
type Drive = { assistants: Yielded[]; thrown: string | null; wire: Wire; servedBy: string | undefined; repaints: number; requestedRow: Row; servingRow: Row; cost: number }

async function drive(servedModel: string): Promise<Drive> {
  ledger.resetCostState()
  pulse.resetPhaseForTests()
  let repaints = 0
  const unsubscribe = pulse.subscribePulsePhase(() => {
    if (pulse.getPulsePhase().detail.servedBy !== undefined) repaints++
  })
  const wire: Wire = { requests: 0, requestedModels: [] }
  const controller = new AbortController()
  const assistants: Yielded[] = []
  let thrown: string | null = null
  const deadline = setTimeout(() => controller.abort(), 30_000)
  const gen = queryModelWithStreaming({
    messages: [createUserMessage({ content: 'served-model fixture prompt' })],
    systemPrompt: asSystemPrompt(['You are the served-model fixture.']),
    thinkingConfig: { type: 'disabled' } as never,
    tools: [],
    signal: controller.signal,
    options: {
      model: REQUESTED,
      querySource: 'sdk',
      isNonInteractiveSession: true,
      fetchOverride: fixtureFetch(framesServedBy(servedModel), wire) as never,
      maxRetries: 0,
      getToolPermissionContext: async () =>
        ({ mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} }) as never,
    } as never,
  })
  try {
    for await (const ev of gen) {
      const item = ev as Yielded
      if (item.type === 'assistant') assistants.push(item)
    }
  } catch (e) {
    thrown = String(e)
  }
  clearTimeout(deadline)
  unsubscribe()
  return {
    assistants,
    thrown,
    wire,
    servedBy: pulse.getPulsePhase().detail.servedBy,
    repaints,
    requestedRow: ledger.getUsageForModel(REQUESTED),
    servingRow: ledger.getUsageForModel(servedModel),
    cost: ledger.getTotalCost(),
  }
}

const byline = (phase: 'waiting' | 'thinking', detail: { model?: string; servedBy?: string; effort?: string }, verb?: string, maxWidth = WIDE): string | null =>
  composePhaseByline({ phase, detail, activeToolCount: 0, maxWidth, verb })

console.log('============================================================')
console.log(' the served-model law — the model that answers is the model named, priced and stamped')
console.log('============================================================')

section('§1 message_start names another family: the byline, the stamp and the bill follow the serving model')
{
  const d = await drive(OTHER_FAMILY)
  const servingName = getPublicModelDisplayName(OTHER_FAMILY) ?? OTHER_FAMILY
  const requestedName = getPublicModelDisplayName(REQUESTED) ?? REQUESTED
  check('the premise: the two ids are different canonical families', getCanonicalName(OTHER_FAMILY) !== getCanonicalName(REQUESTED), `${getCanonicalName(OTHER_FAMILY)} vs ${getCanonicalName(REQUESTED)}`)
  check('one request left the core, asking for the requested model', d.wire.requests === 1 && d.wire.requestedModels[0] === REQUESTED, JSON.stringify(d.wire))
  check('the stream settled without a thrown error', d.thrown === null, d.thrown ?? '')
  check('exactly one assistant message was minted', d.assistants.length === 1, String(d.assistants.length))
  check('the stamp: the minted message carries the serving model, never the requested one', d.assistants[0]?.message?.model === OTHER_FAMILY, String(d.assistants[0]?.message?.model))
  check("the bill: the ledger's usage row is the serving model's (500 in, 40 out)", d.servingRow?.inputTokens === 500 && d.servingRow?.outputTokens === 40, JSON.stringify(d.servingRow))
  check('…and no row was opened under the requested model', d.requestedRow === undefined, JSON.stringify(d.requestedRow))
  check('…and the turn is priced (never a zero row)', d.cost > 0, String(d.cost))
  check("the phase detail carries the serving model's display name as servedBy", d.servedBy === servingName, String(d.servedBy))
  check('the serving model landing on the phase detail repainted the byline at least once', d.repaints >= 1, String(d.repaints))
  const detail = { model: requestedName, servedBy: d.servedBy }
  check('the waiting byline names the serving model, marked (fallback), in place of the requested one', byline('waiting', detail, 'Pondering') === `Pondering · waiting for ${servingName} (fallback)`, String(byline('waiting', detail, 'Pondering')))
  check('the thinking byline carries the serving model first among the extras', byline('thinking', detail, 'Pondering') === `Pondering · thinking · ${servingName} (fallback)`, String(byline('thinking', detail, 'Pondering')))
}

section('§2 the same canonical family is never a substitute: a dated twin and the exact id leave no mark and bill the requested model')
{
  check('the premise: the dated twin canonicalizes onto the requested family', getCanonicalName(DATED_TWIN) === getCanonicalName(REQUESTED), getCanonicalName(DATED_TWIN))
  const requestedName = getPublicModelDisplayName(REQUESTED) ?? REQUESTED
  for (const echoed of [DATED_TWIN, REQUESTED]) {
    const d = await drive(echoed)
    check(`${echoed}: the stream settled and one message was minted`, d.thrown === null && d.assistants.length === 1, d.thrown ?? String(d.assistants.length))
    check(`${echoed}: no servedBy reaches the phase detail`, d.servedBy === undefined && d.repaints === 0, `${String(d.servedBy)} repaints=${d.repaints}`)
    check(`${echoed}: the bill stays under the requested model (500 in, 40 out)`, d.requestedRow?.inputTokens === 500 && d.requestedRow?.outputTokens === 40, JSON.stringify(d.requestedRow))
    check(`${echoed}: the message carries the wire's own model word unchanged`, d.assistants[0]?.message?.model === echoed, String(d.assistants[0]?.message?.model))
    const detail = { model: requestedName, servedBy: d.servedBy }
    check(`${echoed}: the waiting byline is the requested spelling, no mark`, byline('waiting', detail, 'Pondering') === `Pondering · waiting for ${requestedName}`, String(byline('waiting', detail, 'Pondering')))
  }
}

section('§3 the byline spellings with and without a serving model, at width and narrow')
{
  const served = { model: 'Fable 5.1', servedBy: 'Opus 5', effort: 'high' }
  const plain = { model: 'Fable 5.1', effort: 'high' }
  check('waiting + verb: the serving model outranks the requested one', byline('waiting', served, 'Pondering') === 'Pondering · waiting for Opus 5 (fallback) · high', String(byline('waiting', served, 'Pondering')))
  check('waiting + verb, no serving model: the requested spelling is unchanged', byline('waiting', plain, 'Pondering') === 'Pondering · waiting for Fable 5.1 · high', String(byline('waiting', plain, 'Pondering')))
  check('waiting, no verb: the causal spelling names the serving model', byline('waiting', served) === 'Waiting for Opus 5 (fallback) · high', String(byline('waiting', served)))
  check('thinking + verb: the serving model rides first among the extras', byline('thinking', served, 'Pondering') === 'Pondering · thinking · Opus 5 (fallback) · high', String(byline('thinking', served, 'Pondering')))
  check('thinking, no verb: the same order without the verb', byline('thinking', served) === 'Thinking · Opus 5 (fallback) · high', String(byline('thinking', served)))
  check('thinking, no serving model: the extras are the effort alone', byline('thinking', plain, 'Pondering') === 'Pondering · thinking · high', String(byline('thinking', plain, 'Pondering')))
  check('a narrow row sheds the serving model with the rest of the tail, never a truncated name', byline('waiting', served, 'Pondering', 30) === 'Pondering · waiting · high', String(byline('waiting', served, 'Pondering', 30)))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} served-model check(s) failed`)
  process.exit(1)
}
console.log(' ALL SERVED-MODEL PROOFS PASS')
