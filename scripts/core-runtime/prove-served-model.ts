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
const { getCanonicalName } = await import('../../src/utils/model/model.ts')

const REQUESTED = 'claude-fable-5-1'
const OTHER_FAMILY = 'claude-opus-5'
const DATED_TWIN = 'claude-fable-5-1-20260901'

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
type Drive = { assistants: Yielded[]; thrown: string | null; wire: Wire; requestedRow: Row; servingRow: Row; cost: number }

async function drive(servedModel: string): Promise<Drive> {
  ledger.resetCostState()
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
  return {
    assistants,
    thrown,
    wire,
    requestedRow: ledger.getUsageForModel(REQUESTED),
    servingRow: ledger.getUsageForModel(servedModel),
    cost: ledger.getTotalCost(),
  }
}

console.log('============================================================')
console.log(' the served-model law — the model that answers is the model stamped on the turn and billed for it')
console.log('============================================================')

section('§1 message_start names another family: the minted message and the ledger follow the serving model')
{
  const d = await drive(OTHER_FAMILY)
  check('the premise: the two ids are different canonical families', getCanonicalName(OTHER_FAMILY) !== getCanonicalName(REQUESTED), `${getCanonicalName(OTHER_FAMILY)} vs ${getCanonicalName(REQUESTED)}`)
  check('one request left the core, asking for the requested model', d.wire.requests === 1 && d.wire.requestedModels[0] === REQUESTED, JSON.stringify(d.wire))
  check('the stream settled without a thrown error', d.thrown === null, d.thrown ?? '')
  check('exactly one assistant message was minted', d.assistants.length === 1, String(d.assistants.length))
  check('the stamp: the minted message carries the serving model, never the requested one', d.assistants[0]?.message?.model === OTHER_FAMILY, String(d.assistants[0]?.message?.model))
  check("the bill: the ledger's usage row is the serving model's (500 in, 40 out)", d.servingRow?.inputTokens === 500 && d.servingRow?.outputTokens === 40, JSON.stringify(d.servingRow))
  check('…and no row was opened under the requested model', d.requestedRow === undefined, JSON.stringify(d.requestedRow))
  check('…and the turn is priced (never a zero row)', d.cost > 0, String(d.cost))
}

section('§2 the same canonical family is never a substitute: a dated twin and the exact id bill the requested model')
{
  check('the premise: the dated twin canonicalizes onto the requested family', getCanonicalName(DATED_TWIN) === getCanonicalName(REQUESTED), getCanonicalName(DATED_TWIN))
  for (const echoed of [DATED_TWIN, REQUESTED]) {
    const d = await drive(echoed)
    check(`${echoed}: the stream settled and one message was minted`, d.thrown === null && d.assistants.length === 1, d.thrown ?? String(d.assistants.length))
    check(`${echoed}: the bill stays under the requested model (500 in, 40 out)`, d.requestedRow?.inputTokens === 500 && d.requestedRow?.outputTokens === 40, JSON.stringify(d.requestedRow))
    check(`${echoed}: the message carries the wire's own model word unchanged`, d.assistants[0]?.message?.model === echoed, String(d.assistants[0]?.message?.model))
  }
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} served-model check(s) failed`)
  process.exit(1)
}
console.log(' ALL SERVED-MODEL PROOFS PASS')
