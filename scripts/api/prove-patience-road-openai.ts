#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'patience-openai-home-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.NODE_ENV

const { streamOpenaiResponses } = await import('../../src/services/providers/openai/openaiClient.js')
const idle = await import('../../src/services/providers/streamIdleBudget.js')
const settings = await import('../../src/utils/settings/settings.js')
const settingsCache = await import('../../src/utils/settings/settingsCache.js')
const fixture = await import('./patience-road-fixture.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const REQUEST = { model: 'gpt-5.6-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patience' }] }], stream: true }
const HEAD = [fixture.sse({ type: 'response.created', response: { id: 'resp_patience' } })]
const TAIL = [
  fixture.sse({ type: 'response.output_text.delta', delta: 'the reply' }),
  fixture.sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the reply' }] } }),
  fixture.sse({ type: 'response.completed', response: { id: 'resp_patience', usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
]

type Played = { events: Array<{ type: string; fault?: { kind: string; code: string; message: string } }>; elapsedMs: number; fixture: ReturnType<typeof fixture.roadFixture> }
async function play(silence: boolean): Promise<Played> {
  const road = fixture.roadFixture({ head: HEAD, tail: TAIL, silence })
  const started = Date.now()
  const events: Played['events'] = []
  for await (const event of streamOpenaiResponses({
    baseUrl: 'http://127.0.0.1:9/openai/v1',
    headers: { authorization: 'Bearer fixture' },
    request: REQUEST as never,
    fetchImpl: road.fetchImpl,
    idleTimeoutMs: fixture.ROAD_BUDGET_MS,
  })) {
    events.push(event as Played['events'][number])
  }
  return { events, elapsedMs: Date.now() - started, fixture: road }
}
const faults = (p: Played) => p.events.filter(e => e.type === 'stream-fault').map(e => e.fault)

section('R1 — fed: comment keep-alives alone keep the stream alive for three budgets')
{
  const run = await play(false)
  check('every keep-alive was sent and the stream reached its completion', run.fixture.sent() === fixture.KEEP_ALIVES && run.events.some(e => e.type === 'text-delta') && run.events.some(e => e.type === 'usage'), JSON.stringify(run.events.map(e => e.type)))
  check('no fault: the watchdog was fed by the transport, never by an event', faults(run).length === 0, JSON.stringify(faults(run)))
  check('the stream outlived the budget by the keep-alives\' whole span', run.elapsedMs >= fixture.KEEP_ALIVE_EVERY_MS * fixture.KEEP_ALIVES && run.elapsedMs > fixture.ROAD_BUDGET_MS * 2, String(run.elapsedMs))
}

section('R2 — silence: the response opens, then nothing — cut at the budget with its reason')
{
  const run = await play(true)
  const fault = faults(run)[0]
  check('one idle fault, typed, naming the silence', faults(run).length === 1 && fault?.kind === 'timeout' && fault.code === 'idle-timeout' && fault.message === fixture.idleFaultWords(fixture.ROAD_BUDGET_MS), JSON.stringify(faults(run)))
  check('the cut came at the budget, not before and not long after', run.elapsedMs >= fixture.ROAD_BUDGET_MS && run.elapsedMs < fixture.ROAD_BUDGET_MS * 4, String(run.elapsedMs))
  await new Promise(resolve => setTimeout(resolve, 20))
  check('the read was cancelled: no socket outlives the cut', run.fixture.cancelled())
}

section('R3 — the number: the quiet road lives under the quiet budget; the pin outranks it')
{
  check('normal: 15 min', idle.streamIdleTimeoutMsForRoute('openai') === 900_000, String(idle.streamIdleTimeoutMsForRoute('openai')))
  const { error } = settings.updateSettingsForSource('userSettings', { patience: 'patient' } as never)
  settingsCache.resetSettingsCache()
  check('patient: 30 min', error === null && idle.streamIdleTimeoutMsForRoute('openai') === 1_800_000, String(idle.streamIdleTimeoutMsForRoute('openai')))
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '2000'
  check('the env pin outranks the setting', idle.streamIdleTimeoutMsForRoute('openai') === 2_000)
  delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  settings.updateSettingsForSource('userSettings', { patience: undefined } as never)
  settingsCache.resetSettingsCache()
}

console.log(failures === 0 ? '\nprove-patience-road-openai: all green' : `\nprove-patience-road-openai: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
