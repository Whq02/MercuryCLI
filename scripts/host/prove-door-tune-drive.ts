import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner, liveCatalogue } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import { vastFixture } from './vastFixture.mjs'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
const rp = await runpodFixture()
const vast = await vastFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === 'https://api.runpod.io') return nativeFetch(new Request(rp.baseUrl.replace('/v2', '') + url.pathname + url.search, request))
  if (url.origin === 'https://console.vast.ai') return nativeFetch(new Request(vast.baseUrl.replace('/api/v0', '') + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('Door tune proof only permits loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
const jobs: Promise<void>[] = []
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostRunner, closeHostTunnel } = await import('../../src/services/host/ssh.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { readHostRecord } = await import('../../src/services/host/store.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { readTunePreferences } = await import('../../src/services/host/tune.ts')
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const recipe = currentHostRecipes().find(row => row.id === 'glm53-flash-gguf-b300')!
  const model = recipe.label.split(' · ')[0]!
  writeStoredRunpodApiKey(rp.key)
  rp.state.customGpus = liveCatalogue.gpus.filter((row: any) => row.id === 'NVIDIA B300 SXM6 AC').map((row: any) => ({ ...row, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }))
  f.state.dialect = 'llamacpp'; f.state.window = 131072; f.state.slots = 4
  ssh = fakeSshRunner(f.baseUrl, hostRunner, f.state)
  ssh.state.gpus = 'NVIDIA B300, 294912\nDOCKER_ENGINE_PRESENT'
  const queued: string[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, pauseMs: 10, readyTimeoutMs: 3000, sessionId: 'door-tune-proof', startJob: record => {
    queued.push(record.id)
    jobs.push(runHostJob(record.id, record.generation!, { runner: ssh!.runner, pauseMs: 10, timeoutMs: 3000, keepAlive: false }))
  } })
  let plan: LlmHostQuestion | undefined
  const observed: LlmHostRoad = (ask, emit, signal) => road(question => { plan = question; return ask(question) }, emit, signal)
  const until = async (predicate: () => boolean, name: string) => assert.ok(await waitFor(predicate, 15000), name + '\n' + mounted!.screen())
  const step = (name: string) => until(() => plan?.step === name && mounted!.screen().includes(plan.title), name)
  const selected = () => mounted!.lines().find(row => row.includes('› ')) ?? ''
  const choose = async (text: string) => {
    for (let n = 0; n < 60; n++) {
      const before = selected()
      if (before.includes(text)) { mounted!.push(KEY.enter); return }
      const lines = mounted!.lines()
      const target = lines.findIndex(row => row.includes(text))
      const cursor = lines.findIndex(row => row.includes('› '))
      mounted!.push(target >= 0 && target < cursor ? KEY.up : KEY.down)
      await until(() => selected() !== before, 'select ' + text)
    }
    throw new Error('Missing choice ' + text)
  }
  const close = async () => { mounted!.push(KEY.esc); await until(() => !popup.isSettingsPopupOpen(), 'closed') }
  for (const width of [120, 80]) {
    plan = undefined
    popup.openSettingsPopup(llmHostPopupRequest(observed))
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height: 44 }, React.createElement(SettingsPopupSlot)))), width, 44)
    const capture = async (name: string) => {
      check(width + ' ' + name + ' has an exit and no render error', mounted!.screen().includes('esc') && !mounted!.screen().includes('RENDER ERROR'))
      if (!frames) return
      const path = join(frames, width + '-' + name)
      writeFileSync(path + '.txt', mounted!.screen())
      const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
      writeFileSync(path + '.json', JSON.stringify({ grid, cols: width, rows: 44 }))
      await gridToPng(path + '.json', path + '.png')
    }
    await step('door-models'); await capture('models'); await choose(model)
    await step('door-model'); await capture('model'); await choose('Rent · Runpod')
    await until(() => plan?.step === 'rent-confirm' || plan?.step === 'door-confirm', 'rental confirmation')
    await capture('rental-before')
    check('door rental confirmation exposes Tune', plan!.rows?.some(row => row.value === 'tune'))
    check('door uses one decorated prebuilt-engine estimate', plan!.willRun.includes('Engine from image ~1 min') && !plan!.title.includes('min'))
    check('no rental before consent', rp.state.creates === queued.length && queued.length === (width === 120 ? 0 : 1))
    await choose('Tune:'); await step('tune-quality'); check('Tune starts on the quality from the rental confirmation', plan!.initial === recipe.id && selected().includes('Balanced')); await capture('quality'); await choose('Balanced')
    await step('tune-context'); await capture('context'); await choose(width === 120 ? '1 × 1M' : '2 × 512k')
    await step('tune-thinking'); await capture('thinking'); await choose('high')
    await step('tune-confirm'); await capture('tune-confirm'); await choose('Confirm · save')
    await step('rent-confirm'); await capture('rental-after')
    const conversations = width === 120 ? 1 : 2
    const context = width === 120 ? 1048576 : 524288
    check('changed split returns to the same money boundary', plan!.willRun.includes(width === 120 ? '1 × 1M' : '2 × 512k') && plan!.willRun.includes('high'))
    check('current consent is not mixed with stale pre-Tune context', !mounted!.screen().includes('131,072 context') && !mounted!.screen().includes('saved for next rental'))
    check('all rental controls remain visible at this width', mounted!.screen().includes('Tune:') && mounted!.screen().includes('Confirm $8.99/hr') && mounted!.screen().includes('keep things as they are'))
    await choose('Confirm $8.99/hr'); await step('pod-controls'); await Promise.all(jobs)
    const record = readHostRecord(queued.at(-1)!)!
    check('door creates one pod carrying its confirmed preferences', record.jobState === 'ready' && record.tune?.quality === recipe.id && record.tune.conversations === conversations && record.tune.contextPerConversation === context && record.tune.effort === 'high')
    check('door setup launches the chosen total context and conversation count', ssh!.state.script.includes("'--ctx-size' '1048576'") && ssh!.state.script.includes("'--parallel' '" + conversations + "'"))
    check('stored preferences match the created rental', readTunePreferences(model)?.conversations === conversations)
    check('ready pod controls expose Tune without closing and reopening', await waitFor(() => mounted!.screen().includes('Tune · quality'), 4000))
    await capture('controls'); await close()
    popup.openSettingsPopup(llmHostPopupRequest(observed)); await step('door-models'); await choose('Pods I’m paying for'); await step('paid-pods'); await choose(record.id); await step('pod-controls')
    await choose('Tune ·'); await step('tune-quality'); await choose('Balanced'); await step('tune-context'); await choose('4 × 128k'); await step('tune-thinking'); await choose('max'); await step('tune-confirm'); await capture('reload-confirm'); await choose('Confirm · reload'); await step('pod-controls')
    check('a door-rented pod retunes in place without a second rental', rp.state.creates === queued.length && readHostRecord(record.id)?.tune?.conversations === 4 && readHostRecord(record.id)?.tune?.effort === 'max')
    await close(); closeHostTunnel(record.id)
    mounted.unmount(); mounted = undefined
  }
  const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { writeKeptVolume } = await import('../../src/services/host/volumes.ts')
  saveVendorKey('vast', vast.key)
  const kept = { id: 'fixture-kept', name: 'fixture-kept', model: recipe.model, include: recipe.include ?? '', kind: 'network' as const, dataCenter: 'EU-NL-1', size: 300, price: 21, createdAt: new Date().toISOString(), state: 'kept' as const }
  writeKeptVolume(kept)
  rp.state.volumes.set(kept.id, { id: kept.id, name: kept.name, kind: 'network', size: kept.size, dataCenter: kept.dataCenter, type: 'STANDARD' })
  const qualityPods: string[] = []
  const qualityRoad = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, sessionId: 'door-quality-proof', startJob: record => { qualityPods.push(record.id) } })
  const observedQuality: LlmHostRoad = (ask, emit, signal) => qualityRoad(question => { plan = question; return ask(question) }, emit, signal)
  for (const [width, vendor, quality, id] of [[120, 'Runpod', '8× B300', 'glm53-flash-b300'], [80, 'Vast.ai', 'Fast crew', 'glm53-flash-b200-community']] as const) {
    popup.openSettingsPopup(llmHostPopupRequest(observedQuality))
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height: 44 }, React.createElement(SettingsPopupSlot)))), width, 44)
    await step('door-models'); await choose(model); await step('door-model'); await choose('Rent · ' + vendor); await step('rent-confirm')
    if (vendor === 'Runpod') check('door confirmation recognizes kept weights before changing quality', plan!.title.includes('weights kept') && plan!.willRun.includes('weights kept ~0'))
    else check('Vast ignores the Runpod kept disk', !plan!.title.includes('weights kept') && !plan!.willRun.includes('weights kept ~0'))
    await choose('Tune:'); await step('tune-quality'); await choose(quality); await step('tune-context'); check('non-llama quality offers its documented default split', plan!.rows?.length === 1 && selected()); mounted.push(KEY.enter); await step('tune-thinking'); await choose('default'); await step('tune-confirm'); await choose('Confirm · save'); await step('rent-confirm')
    check(vendor + ' changed quality has a live offer and a price confirmation', plan!.rows?.some(row => row.value === 'rent') && plan!.found.includes(vendor === 'Runpod' ? '8× B300' : '4× B200'))
    check(vendor + ' changed weights do not inherit the previous disk', !plan!.title.includes('weights kept') && !plan!.willRun.includes('weights kept ~0'))
    if (frames) {
      const path = join(frames, width + '-quality-change')
      writeFileSync(path + '.txt', mounted.screen())
      const grid = mounted.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
      writeFileSync(path + '.json', JSON.stringify({ grid, cols: width, rows: 44 }))
      await gridToPng(path + '.json', path + '.png')
    }
    await choose('Confirm $'); await step('pod-controls')
    const record = readHostRecord(qualityPods.at(-1)!)!
    check(vendor + ' creates the changed offer and tuning snapshot', record.recipe === id && record.tune?.quality === id && !record.volumeId)
    await close(); mounted.unmount(); mounted = undefined
  }
  check('Vast rental sends the changed GPU offer and never a Runpod disk', vast.requests.some((request: any) => request.method === 'PUT' && request.path === '/api/v0/asks/103/' && !request.body.mounts))
  check('all network stays on loopback', escaped.length === 0)
  console.log('DOOR TUNE DRIVE GREEN — ' + checks + ' checks')
} finally {
  mounted?.unmount()
  await Promise.allSettled(jobs)
  ssh?.close(); await rp.close(); await vast.close(); f.close(); globalThis.fetch = nativeFetch
}
