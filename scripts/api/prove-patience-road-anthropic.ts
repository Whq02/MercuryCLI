#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'patience-anthropic-home-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.NODE_ENV

const idle = await import('../../src/models/roads/streamIdleBudget.js')
const settings = await import('../../src/platform/settings/settings.js')
const settingsCache = await import('../../src/platform/settings/settingsCache.js')
const fixture = await import('./patience-road-fixture.js')
const { AnthropicStream: Stream } = await import('../../src/models/roads/anthropic/anthropicStream.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const event = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
const HEAD = [
  event('message_start', { type: 'message_start', message: { id: 'synthetic', role: 'assistant', content: [] } }),
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
]
const TAIL = [event('content_block_stop', { type: 'content_block_stop', index: 0 }), event('message_stop', { type: 'message_stop' })]

type Played = { yielded: number; terminal: boolean; fire: ReturnType<ReturnType<typeof idle.createStreamIdleWatchdog>['fired']>; noted: number; sent: number; elapsedMs: number }

async function play(silence: boolean): Promise<Played> {
  const road = fixture.roadFixture({ head: HEAD, tail: TAIL, silence })
  const controller = new AbortController()
  const started = Date.now()
  const watchdog = idle.createStreamIdleWatchdog({ timeoutMs: fixture.ROAD_BUDGET_MS, onFire: () => controller.abort() })
  let noted = 0
  let yielded = 0
  let terminal = false
  const answered = await road.fetchImpl('http://127.0.0.1:9/v1/messages', { method: 'POST', signal: controller.signal })
  const tapped = idle.observeStreamActivity(answered, () => {
    noted++
    watchdog.noteActivity()
  })
  try {
    for await (const part of Stream.fromSSEResponse(tapped, controller)) {
      watchdog.noteActivity()
      yielded++
      terminal ||= part.type === 'message_stop'
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    watchdog.stop()
  }
  return { yielded, terminal, fire: watchdog.fired(), noted, sent: road.sent(), elapsedMs: Date.now() - started }
}

section('R1 — fed: the pings the parser drops keep the stream alive for three budgets')
{
  const run = await play(false)
  check('every keep-alive was sent and the stream lived to message_stop with no fire', run.sent === fixture.KEEP_ALIVES && run.terminal && run.fire === null, JSON.stringify(run) + ' | keep-alive pings the parser drops must still count as activity: see observeStreamActivity and createStreamIdleWatchdog in src/models/roads/streamIdleBudget.ts')
  check('the parser yielded only its four events; the tap noted at least every keep-alive', run.yielded === 4 && run.noted >= fixture.KEEP_ALIVES, JSON.stringify(run) + ' | observeStreamActivity in src/models/roads/streamIdleBudget.ts must call its callback for every chunk read, including pings; AnthropicStream.fromSSEResponse in src/models/roads/anthropic/anthropicStream.ts must still yield only the four real events')
  check('the stream outlived the budget by the keep-alives\' whole span', run.elapsedMs >= fixture.KEEP_ALIVE_EVERY_MS * fixture.KEEP_ALIVES && run.elapsedMs > fixture.ROAD_BUDGET_MS * 2, String(run.elapsedMs) + ' ms | the stream ended early; createStreamIdleWatchdog in src/models/roads/streamIdleBudget.ts must not fire while activity keeps arriving')
}

section('R2 — silence: two events, then nothing — the budget fires at its number')
{
  const run = await play(true)
  check('the budget fired with the silence measured; the stream never reached its end', run.fire !== null && run.fire.silentMs >= fixture.ROAD_BUDGET_MS && run.yielded === 2 && !run.terminal, JSON.stringify(run) + ' | createStreamIdleWatchdog in src/models/roads/streamIdleBudget.ts must fire once the silence reaches timeoutMs and report silentMs')
  check('the cut came at the budget, not before and not long after', run.elapsedMs >= fixture.ROAD_BUDGET_MS && run.elapsedMs < fixture.ROAD_BUDGET_MS * 4, String(run.elapsedMs) + ' ms | the watchdog in src/models/roads/streamIdleBudget.ts must fire at its budget, not earlier and not much later')
}

section('R3 — the number: the fed road lives under the fed budget; the pin outranks it')
{
  check('normal: 6 min', idle.streamIdleTimeoutMsForRoute('anthropic') === 360_000, String(idle.streamIdleTimeoutMsForRoute('anthropic')) + ' | the default for the anthropic route in streamIdleTimeoutMsForRoute, src/models/roads/streamIdleBudget.ts, must be 360000 ms')
  check('the first-byte budget on a warm prefix is the road\'s number', idle.firstByteBudgetMs({ cold: false, promptTokens: 50_000, idleMs: idle.streamIdleTimeoutMsForRoute('anthropic') }) === 360_000, 'firstByteBudgetMs in src/models/roads/streamIdleBudget.ts must return the route idle budget for a warm prefix')
  const { error } = settings.updateSettingsForSource('userSettings', { patience: 'patient' } as never)
  settingsCache.resetSettingsCache()
  check('patient: 12 min', error === null && idle.streamIdleTimeoutMsForRoute('anthropic') === 720_000, String(idle.streamIdleTimeoutMsForRoute('anthropic')) + ' | the patience setting patient must double the route budget to 720000 ms in streamIdleTimeoutMsForRoute, src/models/roads/streamIdleBudget.ts; updateSettingsForSource error: ' + String(error))
  check('patient: the first-byte budget on a warm prefix follows', idle.firstByteBudgetMs({ cold: false, promptTokens: 50_000, idleMs: idle.streamIdleTimeoutMsForRoute('anthropic') }) === 720_000, 'firstByteBudgetMs in src/models/roads/streamIdleBudget.ts must follow the patient route budget for a warm prefix')
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '2000'
  check('the env pin outranks the setting', idle.streamIdleTimeoutMsForRoute('anthropic') === 2_000, 'streamIdleTimeoutMsForRoute in src/models/roads/streamIdleBudget.ts must let MERCURY_STREAM_IDLE_TIMEOUT_MS win over the patience setting; got ' + String(idle.streamIdleTimeoutMsForRoute('anthropic')))
  delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  settings.updateSettingsForSource('userSettings', { patience: undefined } as never)
  settingsCache.resetSettingsCache()
}

console.log(failures === 0 ? '\nprove-patience-road-anthropic: all green' : `\nprove-patience-road-anthropic: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
