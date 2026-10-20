import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'
import { boxFixture } from './boxFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
const only = option('--only')
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
const rp = await runpodFixture()
const vast = await vastFixture()
const lambda = await lambdaFixture()
const box = boxFixture(f.home)
const nativeFetch = globalThis.fetch
let denyVastPods = false
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const base = ({ 'https://api.runpod.io': rp.baseUrl.replace('/v2', ''), 'https://console.vast.ai': vast.baseUrl.replace('/api/v0', ''), 'https://cloud.lambda.ai': lambda.baseUrl.replace('/api/v1', '') } as Record<string, string>)[url.origin]
  if (denyVastPods && url.origin === 'https://console.vast.ai' && url.pathname === '/api/v0/instances/') return Response.json({ error: 'fixture list unavailable' }, { status: 503 })
  if (base) return nativeFetch(new Request(base + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('Seam proof only permits loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
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
  const { modelDoorRoad } = await import('../../src/services/host/door.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { saveVendorKey, vendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const { readHostRecord, writeHostRecord } = await import('../../src/services/host/store.ts')
  const { writeBox } = await import('../../src/services/host/boxes.ts')
  const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  ssh = fakeSshRunner(f.baseUrl, hostRunner, f.state)
  const queued: string[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, sessionId: 'door-seams', startJob: record => { queued.push(record.id) } })
  let plan: LlmHostQuestion | undefined
  let width = 120
  let height = 44
  const mount = async (columns: number, rows: number, body?: React.ReactNode) => {
    width = columns; height = rows
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, body, React.createElement(SettingsPopupSlot)))), width, height)
  }
  const open = async (chosen: LlmHostRoad, columns = 120, rows = 44) => {
    plan = undefined
    const observed: LlmHostRoad = (ask, emit, signal) => chosen(question => { plan = question; return ask(question) }, emit, signal)
    popup.openSettingsPopup(llmHostPopupRequest(observed)); await mount(columns, rows)
  }
  const until = async (predicate: () => boolean, name: string) => assert.ok(await waitFor(predicate, 15000), name + '\n' + mounted!.screen())
  const step = (name: string) => until(() => plan?.step === name && mounted!.screen().includes(plan.title), name)
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const choose = async (text: string) => {
    for (let n = 0; n < 70; n++) {
      const before = selected()
      if (before.includes(text)) { mounted!.push(KEY.enter); return }
      const lines = mounted!.lines(), target = lines.findIndex(line => line.includes(text)), cursor = lines.findIndex(line => line.includes('› '))
      mounted!.push(target >= 0 && target < cursor ? KEY.up : KEY.down)
      assert.ok(await waitFor(() => selected() !== before, 3000), 'visible choice ' + text + '\n' + mounted!.screen())
    }
    throw new Error('Missing choice ' + text)
  }
  const close = async () => { mounted!.push(KEY.esc); await until(() => !popup.isSettingsPopupOpen(), 'closed'); mounted!.unmount(); mounted = undefined }
  const capture = async (name: string) => {
    if (!frames) return
    const path = join(frames, width + 'x' + height + '-' + name)
    writeFileSync(path + '.txt', mounted!.screen())
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
    writeFileSync(path + '.json', JSON.stringify({ grid, cols: width, rows: height })); await gridToPng(path + '.json', path + '.png')
  }
  if (!only || only === 'narrow') {
    const models = ['DeepSeek-V4-Pro-0813', ...new Set(currentHostRecipes().map(row => row.label.split(' · ')[0]!).filter(name => name !== 'DeepSeek-V4-Pro-0813'))]
    for (const [columns, rows] of [[80, 18], [80, 24], [120, 30]]) for (const model of models) {
      await open(modelDoorRoad(road, model), columns, rows); await step('door-model'); await capture(model + '-details')
      mounted!.push(KEY.down)
      check(columns + ' ' + model + ' has a visible selected vendor', await waitFor(() => selected().includes('Connect Runpod'), 3000))
      await capture(model + '-selected')
      let details = mounted!.screen()
      for (;;) {
        const marker = /Details (\d+)–(\d+) of (\d+)/.exec(mounted!.screen())
        if (!marker || marker[2] === marker[3]) break
        const before = mounted!.screen()
        mounted!.push('\x1b[6~'); await until(() => mounted!.screen() !== before, 'details page')
        details += '\n' + mounted!.screen()
        check(columns + ' ' + model + ' pages facts without losing the selected vendor', selected().includes('Connect Runpod'))
      }
      check(columns + ' ' + model + ' keeps every detail section reachable', ['QUALITY', 'CONVERSATIONS × CONTEXT', 'THINKING', 'WHERE'].every(word => details.includes(word)))
      check(columns + ' ' + model + ' rounds display weights without changing their budget', !/\d+\.\d{4}/.test(details))
      await capture(model + '-details-paged')
      await choose('Connect Runpod'); await step('runpod-key')
      check(columns + ' ' + model + ' opens the key only after selecting the vendor', mounted!.screen().includes('Runpod API key'))
      await close()
    }
  }
  if (!only || only === 'cluster') {
    saveVendorKey('runpod', rp.key)
    const gpu = (name: string, memory: number, price: number) => ({ id: 'NVIDIA ' + name, name, memory, secure: true, price: { secure: price }, maxCount: { secure: 8 }, availability: 'HIGH', dataCenters: [{ id: 'FIXTURE-DC', availability: 'HIGH' }] })
    rp.state.customGpus = [gpu('B300', 288, 18.99)]; rp.state.clusterGpus = [gpu('B200', 180, 7.99)]
    for (const columns of [120, 80]) {
      await open(modelDoorRoad(road, 'Kimi K3'), columns); await step('door-model'); await capture('cluster-model'); await choose('B200'); await step('rent-confirm'); await capture('cluster-confirm')
      check('door cluster consent preserves topology and whole-shape price', plan!.found.includes('2 nodes × 8× B200') && plan!.found.includes('$127.84/hr'))
      check('cluster consent keeps billing facts and both choices visible', mounted!.screen().includes('Confirm $127.84/hr') && mounted!.screen().includes('keep things as they are') && mounted!.screen().replace(/[│\s]+/g, ' ').includes('bills until Terminate'))
      await choose('Confirm $127.84/hr'); await step('pod-controls')
      const record = readHostRecord(queued.at(-1)!)!
      check('door creates a cluster family, never a single pod', record.cluster?.compute.podCount === 2 && record.nodes?.length === 2 && rp.state.creates === 0)
      await close()
    }
    rp.state.customGpus = null; rp.state.clusterGpus = []
  }
  if (!only || only === 'box') {
    writeBox({ name: 'fixture-box', kind: 'this-computer', os: 'darwin', arch: 'arm64', home: box.home, uid: 501, memoryGb: 4096, unifiedMemory: true, gpus: [], engines: [{ kind: 'llamacpp', path: box.server, version: 'fixture', port: 8080 }], bankPaths: [box.bank], discoveredAt: new Date().toISOString() })
    const boxRoad = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: box.runner, startJob: () => {} })
    for (const columns of [120, 80]) {
      await open(modelDoorRoad(boxRoad, 'Kimi K3'), columns); await step('door-model'); await choose('this computer')
      await until(() => mounted!.screen().includes('no local recipe') || plan?.step === 'box-recipes', 'local recipe result'); await capture('unmatched-box')
      check('a model with no local recipe never opens an unrelated model chooser', mounted!.screen().includes('no local recipe') && plan?.step !== 'box-recipes')
      check('an unmatched local start performs no download or engine launch', !box.commands.some((entry: any) => /hf download|ollama pull|bootstrap/.test(entry.args.join(' '))))
      await close()
    }
  }
  if (!only || only === 'sweep') {
    saveVendorKey('runpod', rp.key); saveVendorKey('vast', vast.key)
    const stamp = new Date().toISOString()
    const recipe = currentHostRecipes().find(row => row.id === 'qwen38-27b-rtx-pro-6000')!
    for (const vendor of ['runpod', 'vast'] as const) {
      const id = 'missing-' + vendor
      writeHostRecord({ id, vendor, name: id, recipe: recipe.id, status: 'RUNNING', price: 1, startedAt: stamp, provider: id, jobState: 'ready' })
      assert.equal(updateSettingsForSource('userSettings', { compatProvider: { [id]: { baseUrl: f.baseUrl, dialect: 'vllm', label: id, hostPodId: id } } }).error, null)
    }
    denyVastPods = true
    await open(road, 80); await step('door-models'); await capture('partial-list')
    check('a failed vendor list cannot delete either vendor record', readHostRecord('missing-runpod') && readHostRecord('missing-vast'))
    check('partial lists are visibly incomplete', mounted!.screen().replace(/[│\s]+/g, ' ').includes('count incomplete'))
    await choose('Pods I’m paying for'); await step('paid-pods'); await capture('partial-paid'); await close()
    denyVastPods = false
    await open(road); await step('door-models')
    check('complete lists remove genuinely ended records and their model entries', !readHostRecord('missing-runpod') && !readHostRecord('missing-vast') && !configuredCompatEndpoints().some(row => row.name.startsWith('missing-')))
    await close()
  }
  if (!only || only === 'catalogue') {
    for (const columns of [120, 80]) {
      if (!vendorKey('vast')) {
        await open(modelDoorRoad(road, 'Qwen3.8-27B'), columns); await step('door-model'); await choose('Connect Vast.ai'); await step('vast-key'); mounted!.push(vast.key); mounted!.push(KEY.enter); await step('door-model'); await close()
      }
      await open(road, columns); await step('door-models'); await choose('Other roads'); await step('where'); await choose('Fast-load')
      await until(() => plan?.step === 'runpod-key' || plan?.step === 'fast-load', 'fast-load account')
      if (plan!.step === 'runpod-key') { await step('runpod-key'); mounted!.push(rp.key); mounted!.push(KEY.enter) }
      await step('fast-load'); await capture('fast-load-after-vendor')
      check('fast-load after connecting another vendor still uses Runpod disks', plan!.found.includes('Runpod disk') && !plan!.found.includes('Vast') && rp.requests.some((request: any) => request.path.includes('network-volumes')))
      check('opening fast-load creates no disk', rp.state.volumeCreates === 0)
      await close()
    }
  }
  if (!only || only === 'lambda-model') {
    rp.state.noStock = true; vast.state.noStock = true
    saveVendorKey('lambda', lambda.key)
    lambda.state.types.push({ name: 'gpu_1x_rtxpro6000', description: '1x RTX PRO 6000', gpu_description: 'NVIDIA RTX PRO 6000 Blackwell (96 GB)', price_cents_per_hour: 210, specs: { vcpus: 32, memory_gib: 256, storage_gib: 2000, gpus: 1 }, architecture: 'x86_64' })
    const { call: modelCall } = await import('../../src/commands/model/mercuryModel.tsx')
    for (const columns of [120, 80]) {
      let finishPicker = () => {}
      const modelNode = await modelCall(() => finishPicker(), { messages: [] } as never, 'Qwen3.8-27B')
      function PickerHost() { const [visible, setVisible] = React.useState(true); finishPicker = () => setVisible(false); return visible ? modelNode : null }
      await mount(columns, 44, React.createElement(PickerHost)); await until(() => mounted!.screen().includes('run it → /llmhost'), 'model run action')
      for (let n = 0; n < 6 && !popup.isSettingsPopupOpen(); n++) { mounted!.push(KEY.down); mounted!.push(KEY.enter); await waitFor(() => popup.isSettingsPopupOpen(), 500) }
      await until(() => mounted!.screen().includes('Rent · Lambda'), 'Lambda-only model page'); await capture('lambda-only-model')
      check('real model picker reaches Lambda when other vendors have no stock', !mounted!.screen().includes('Rent · Runpod') && !mounted!.screen().includes('Rent · Vast.ai'))
      await choose('Rent · Lambda'); await until(() => mounted!.screen().includes('Confirm the hourly price'), 'Lambda price'); await capture('lambda-only-confirm')
      check('Lambda-only action stops at its own price boundary', mounted!.screen().includes('$2.10/hr') && lambda.state.creates === 0)
      await close()
    }
  }
  if (!only || only === 'manual-endpoint') {
    const { refreshCompatCatalogues } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
    const { writeStoredCompatApiKey, readStoredCompatApiKey } = await import('../../src/services/providers/providerSecrets.ts')
    const { call: modelCall } = await import('../../src/commands/model/mercuryModel.tsx')
    for (const columns of [120, 80]) {
      const name = 'manual-offline'
      assert.equal(updateSettingsForSource('userSettings', { compatProvider: { [name]: { baseUrl: f.baseUrl, dialect: 'vllm', label: name } } }).error, null)
      writeStoredCompatApiKey(f.key, name)
      await refreshCompatCatalogues({ name, force: true, fetchImpl: Object.assign(async () => { throw new Error('fixture offline') }, nativeFetch) })
      const node = await modelCall(() => {}, { messages: [] } as never, name)
      await mount(columns, 44, node); await until(() => mounted!.screen().includes('Remove this endpoint'), 'manual endpoint remove action'); await capture('manual-offline')
      check('hand-registered failure offers Remove instead of a key screen', mounted!.screen().includes('Retry this server') && !mounted!.screen().includes('API key'))
      const before = { pods: rp.state.pods.size, removed: rp.state.deletes, vast: vast.state.deletes, lambda: lambda.state.deletes, requests: f.state.requests }
      mounted!.push(KEY.tab); mounted!.push(KEY.down); mounted!.push(KEY.enter)
      await until(() => mounted!.screen().includes('Removed custom endpoint'), 'manual endpoint removed')
      check('Remove deletes only the endpoint and its key, not any server or pod', !configuredCompatEndpoints().some(row => row.name === name) && !readStoredCompatApiKey(name) && rp.state.pods.size === before.pods && rp.state.deletes === before.removed && vast.state.deletes === before.vast && lambda.state.deletes === before.lambda && f.state.requests === before.requests)
      mounted!.unmount(); mounted = undefined
    }
  }
  check('seams use loopback only', escaped.length === 0)
  console.log('DOOR SEAMS GREEN — ' + checks + ' checks')
} finally { mounted?.unmount(); ssh?.close(); await box.close(); await rp.close(); await vast.close(); await lambda.close(); f.close(); globalThis.fetch = nativeFetch }
