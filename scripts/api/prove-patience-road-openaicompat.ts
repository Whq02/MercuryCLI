#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'patience-compat-home-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.NODE_ENV

const { streamCompatChat } = await import('../../src/models/roads/openaicompat/compatChatClient.js')
const idle = await import('../../src/models/roads/streamIdleBudget.js')
const settings = await import('../../src/platform/settings/settings.js')
const settingsCache = await import('../../src/platform/settings/settingsCache.js')
const fixture = await import('./patience-road-fixture.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const REQUEST = { model: 'fixture-model', messages: [{ role: 'user' as const, content: 'patience' }], stream: true }
const HEAD = [fixture.sse({ choices: [{ delta: { role: 'assistant' } }] })]
const TAIL = [fixture.sse({ choices: [{ delta: { content: 'the reply' } }] }), fixture.sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']

type Played = { events: Array<{ type: string; fault?: { kind: string; code: string; message: string } }>; elapsedMs: number; fixture: ReturnType<typeof fixture.roadFixture> }
async function play(silence: boolean): Promise<Played> {
  const road = fixture.roadFixture({ head: HEAD, tail: TAIL, silence })
  const started = Date.now()
  const events: Played['events'] = []
  for await (const event of streamCompatChat({
    url: 'http://127.0.0.1:9/v1/chat/completions',
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
  check('every keep-alive was sent and the stream reached its finish', run.fixture.sent() === fixture.KEEP_ALIVES && run.events.some(e => e.type === 'text-delta') && run.events.some(e => e.type === 'finish'), JSON.stringify(run.events.map(e => e.type)) + ' — streamCompatChat in src/models/roads/openaicompat/compatChatClient.ts must emit text-delta and finish events for every keep-alive-fed stream')
  check('no fault: the watchdog was fed by every byte', faults(run).length === 0, JSON.stringify(faults(run)) + ' — the idle watchdog in streamCompatChat (src/models/roads/openaicompat/compatChatClient.ts) must count comment keep-alive bytes as activity')
  check('the stream outlived the budget by the keep-alives\' whole span', run.elapsedMs >= fixture.KEEP_ALIVE_EVERY_MS * fixture.KEEP_ALIVES && run.elapsedMs > fixture.ROAD_BUDGET_MS * 2, String(run.elapsedMs) + ' — the watchdog in streamCompatChat (src/models/roads/openaicompat/compatChatClient.ts) must be fed by each keep-alive so the stream is not cut early')
}

section('R2 — silence: the response opens, then nothing — cut at the budget with its reason')
{
  const run = await play(true)
  const fault = faults(run)[0]
  check('one idle fault, typed, naming the silence', faults(run).length === 1 && fault?.kind === 'timeout' && fault.code === 'idle-timeout' && fault.message === fixture.idleFaultWords(fixture.ROAD_BUDGET_MS), JSON.stringify(faults(run)) + ' — streamCompatChat in src/models/roads/openaicompat/compatChatClient.ts must emit exactly one stream-fault with kind timeout and code idle-timeout, worded by streamIdleFaultWords')
  check('the cut came at the budget, not before and not long after', run.elapsedMs >= fixture.ROAD_BUDGET_MS && run.elapsedMs < fixture.ROAD_BUDGET_MS * 4, String(run.elapsedMs) + ' — the idle timer in streamCompatChat (src/models/roads/openaicompat/compatChatClient.ts) must fire at the idleTimeoutMs option')
  await new Promise(resolve => setTimeout(resolve, 20))
  check('the read was cancelled: no socket outlives the cut', run.fixture.cancelled(), 'streamCompatChat in src/models/roads/openaicompat/compatChatClient.ts must call reader.cancel() on the response body when the idle fault is raised')
}

section('R3 — the number: each road follows its patience budget; the pin outranks it')
{
  const fedRoads = ['deepseek', 'openrouter']
  const quietRoads = ['moonshot', 'xai', 'meta', 'gemini', 'huggingface']
  const otherRoads = [...fedRoads, ...quietRoads]
  check('normal: 6 min', idle.streamIdleTimeoutMsForRoute('openai-compat') === 360_000, String(idle.streamIdleTimeoutMsForRoute('openai-compat')) + ' — streamIdleTimeoutMsForRoute in src/models/roads/streamIdleBudget.ts must give the openai-compat road 6 min when patience is normal')
  const { error } = settings.updateSettingsForSource('userSettings', { patience: 'patient' } as never)
  settingsCache.resetSettingsCache()
  check('patient: 12 min', error === null && idle.streamIdleTimeoutMsForRoute('openai-compat') === 720_000, String(idle.streamIdleTimeoutMsForRoute('openai-compat')) + ' — streamIdleTimeoutMsForRoute in src/models/roads/streamIdleBudget.ts must give 12 min when the patience setting is patient, and updateSettingsForSource must have saved it (error must be null)')
  check('the other fed roads on this transport take 12 min under patient', fedRoads.every(road => idle.streamIdleTimeoutMsForRoute(road) === 720_000), fedRoads.map(road => `${road}=${idle.streamIdleTimeoutMsForRoute(road)}`).join(' ') + ' — fix the fed-road number in streamIdleTimeoutMsForRoute (src/models/roads/streamIdleBudget.ts)')
  check('the quiet roads on this transport take 30 min under patient', quietRoads.every(road => idle.streamIdleTimeoutMsForRoute(road) === 1_800_000), quietRoads.map(road => `${road}=${idle.streamIdleTimeoutMsForRoute(road)}`).join(' ') + ' — fix the quiet-road number in streamIdleTimeoutMsForRoute (src/models/roads/streamIdleBudget.ts)')
  check('the local road on this transport takes the quiet number: 30 min under patient (a busy local server is silent while it works)', idle.streamIdleTimeoutMsForRoute('local') === 1_800_000, String(idle.streamIdleTimeoutMsForRoute('local')) + ' — streamIdleTimeoutMsForRoute in src/models/roads/streamIdleBudget.ts must treat local as a quiet road')
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '2000'
  check('the env pin outranks the setting, the other roads and local included', idle.streamIdleTimeoutMsForRoute('openai-compat') === 2_000 && otherRoads.every(road => idle.streamIdleTimeoutMsForRoute(road) === 2_000) && idle.streamIdleTimeoutMsForRoute('local') === 2_000, 'MERCURY_STREAM_IDLE_TIMEOUT_MS must win over the patience setting for every road in streamIdleTimeoutMsForRoute (src/models/roads/streamIdleBudget.ts)')
  delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  settings.updateSettingsForSource('userSettings', { patience: undefined } as never)
  settingsCache.resetSettingsCache()
}

console.log(failures === 0 ? '\nprove-patience-road-openaicompat: all green' : `\nprove-patience-road-openaicompat: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
