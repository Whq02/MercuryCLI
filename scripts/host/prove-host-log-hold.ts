import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture } from './runpodFixture.mjs'
import { KEY, mountOffscreen, pinSourceRef, waitFor } from '../lib/settingsPopupHarness.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR)
pinSourceRef()
const f = await llmhostFixture()
const rp = await runpodFixture()
const fetchImpl = globalThis.fetch
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') throw new Error('Host log proof permits loopback fixtures only')
  return fetchImpl(input, init)
}, fetchImpl)
let mounted: Awaited<ReturnType<typeof mountOffscreen>> | undefined
try {
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { writeHostRecord } = await import('../../src/services/host/store.ts')
  const React = await import('react')
  const { LlmHostDialog } = await import('../../src/components/LlmHostDialog.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  writeStoredRunpodApiKey(rp.key)
  const since = new Date(Date.now() - 3600_000).toISOString()
  rp.state.pods.set('held-log', { id: 'held-log', name: 'Held log', status: 'RUNNING', cost: 3.99, createdAt: since, startedAt: since })
  const log = join(f.home, 'held-engine.log')
  writeFileSync(log, Array.from({ length: 60 }, (_, i) => 'engine line ' + String(i + 1).padStart(2, '0')).join('\n'))
  writeHostRecord({ id: 'held-log', name: 'Held log', recipe: 'gpt-oss-120b-h100', price: 3.99, status: 'RUNNING', startedAt: since, log })
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, sessionId: 'log-hold' })
  let controls = 0
  let held = false
  let dismiss: ((value: string | null) => void) | undefined
  const run = road(async plan => {
    if (plan.step === 'where' || plan.step === 'door-models') return 'pods'
    if (plan.step === 'paid-pods') return 'held-log'
    if (plan.step === 'pod-controls') return ++controls === 1 ? 'logs' : 'close'
    if (plan.step === 'pod-logs') { held = true; assert.match(plan.found, /engine line/); return new Promise(resolve => { dismiss = resolve }) }
    return null
  }, () => {}, new AbortController().signal)
  await waitFor(() => held || controls > 1, 5000)
  assert.ok(held && controls === 1, 'F44R-15: the log holds instead of immediately asking controls again')
  dismiss?.(null)
  await run
  assert.equal(controls, 2, 'dismissing the log returns to controls')
  const logRoad: typeof road = async (ask, emit) => { emit({ title: 'Machine controls', words: '', host: { id: 'held-log', price: 3.99, startedAt: since, status: 'RUNNING', step: 'loading' } }); await ask({ step: 'pod-logs', title: 'Engine log', found: Array.from({ length: 40 }, (_, i) => 'engine line ' + String(i + 1).padStart(2, '0')).join('\n'), willRun: '', rows: [] }); return { ok: true, words: 'Machine controls' } }
  let hint = ''
  mounted = await mountOffscreen(React.createElement(AppStateProvider, { children: React.createElement(ThemeProvider, {}, React.createElement(LlmHostDialog, { width: 80, rowBudget: 24, road: logRoad, onHint: text => { hint = text ?? '' } })) }), 80, 24)
  assert.ok(await waitFor(() => mounted!.screen().includes('engine line 01'), 5000))
  assert.ok(hint.includes('esc closes') && !hint.includes('choose') && !hint.includes('↵ continue'), hint)
  const first = mounted.screen()
  mounted.push('\u001b[6~')
  assert.ok(await waitFor(() => mounted!.screen() !== first, 2000), 'log pages move')
  const page = mounted.screen()
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(mounted.screen(), page, 'the page holds while reading')
  mounted.push(KEY.esc)
  assert.ok(await waitFor(() => mounted!.screen().includes('Machine controls'), 2000), 'the existing Escape dismisses the log without closing the road')
  console.log('HOST LOG HOLD GREEN — road waits, pages hold, Escape returns; no rental')
} finally { mounted?.unmount(); await rp.close(); f.close(); globalThis.fetch = fetchImpl }
