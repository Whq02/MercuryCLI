#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'patience-zai-home-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.NODE_ENV

const { streamZaiChat } = await import('../../src/services/providers/zai/zaiClient.js')
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

const REQUEST = { model: 'glm-5.2', messages: [{ role: 'user' as const, content: 'patience' }] }
const HEAD = [fixture.sse({ choices: [{ delta: { role: 'assistant' } }] })]
const TAIL = [fixture.sse({ choices: [{ delta: { content: 'the reply' } }] }), fixture.sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']

type Played = { events: Array<{ type: string; fault?: { kind: string; code: string; message: string } }>; elapsedMs: number; fixture: ReturnType<typeof fixture.roadFixture> }
async function play(silence: boolean): Promise<Played> {
  const road = fixture.roadFixture({ head: HEAD, tail: TAIL, silence })
  const started = Date.now()
  const events: Played['events'] = []
  for await (const event of streamZaiChat({ apiKey: 'fixture-key', request: REQUEST, fetchImpl: road.fetchImpl, idleTimeoutMs: fixture.ROAD_BUDGET_MS })) {
    events.push(event as Played['events'][number])
  }
  return { events, elapsedMs: Date.now() - started, fixture: road }
}
const faults = (p: Played) => p.events.filter(e => e.type === 'stream-fault').map(e => e.fault)

section('R1 — fed: comment keep-alives alone keep the stream alive for three budgets')
{
  const run = await play(false)
  check('every keep-alive was sent and the stream reached its finish', run.fixture.sent() === fixture.KEEP_ALIVES && run.events.some(e => e.type === 'text-delta') && run.events.some(e => e.type === 'finish'), JSON.stringify(run.events.map(e => e.type)))
  check('no fault: the watchdog was fed by every byte', faults(run).length === 0, JSON.stringify(faults(run)))
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

section('R3 — the number: the fed road lives under the fed budget; the pin outranks it')
{
  check('normal: 5 min', idle.streamIdleTimeoutMsForRoute('zai') === 300_000, String(idle.streamIdleTimeoutMsForRoute('zai')))
  const { error } = settings.updateSettingsForSource('userSettings', { patience: 'patient' } as never)
  settingsCache.resetSettingsCache()
  check('patient: 10 min', error === null && idle.streamIdleTimeoutMsForRoute('zai') === 600_000, String(idle.streamIdleTimeoutMsForRoute('zai')))
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '2000'
  check('the env pin outranks the setting', idle.streamIdleTimeoutMsForRoute('zai') === 2_000)
  delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  settings.updateSettingsForSource('userSettings', { patience: undefined } as never)
  settingsCache.resetSettingsCache()
}

console.log(failures === 0 ? '\nprove-patience-road-zai: all green' : `\nprove-patience-road-zai: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
