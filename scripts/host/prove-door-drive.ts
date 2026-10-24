import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner, liveCatalogue } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
const rp = await runpodFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === 'https://api.runpod.io') return nativeFetch(new Request(rp.baseUrl.replace('/v2', '') + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('Door proof only permits loopback fixtures') }
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
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { writeHostRecord, readHostRecord } = await import('../../src/services/host/store.ts')
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  writeStoredRunpodApiKey(rp.key)
  const recipes = currentHostRecipes()
  const runningRecipe = recipes.find(recipe => recipe.id === 'glm53-flash-gguf-b300')!
  const gpu = liveCatalogue.gpus.find((row: any) => row.id === 'NVIDIA B300 SXM6 AC')!
  const since = new Date(Date.now() - 3600_000).toISOString()
  rp.state.pods.set('fixture-paid', { id: 'fixture-paid', name: 'Already paid', status: 'RUNNING', cost: gpu.price.secure, createdAt: since, startedAt: since })
  writeHostRecord({ id: 'fixture-paid', name: runningRecipe.label, recipe: runningRecipe.id, status: 'RUNNING', price: gpu.price.secure, startedAt: since, provider: 'door-paid', jobState: 'ready' })
  assert.equal(updateSettingsForSource('userSettings', { compatProvider: { 'door-paid': { baseUrl: f.baseUrl, dialect: 'llamacpp', label: 'Paid fixture' } } }).error, null)
  f.state.dialect = 'llamacpp'; f.state.window = runningRecipe.context!; f.state.slots = Number(runningRecipe.flags[runningRecipe.flags.indexOf('--parallel') + 1])
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const queued: string[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, sessionId: 'door-proof', startJob: record => { queued.push(record.id) } })
  let width = 120
  const open = (chosenRoad = road) => popup.openSettingsPopup(llmHostPopupRequest(chosenRoad))
  const mount = async (columns: number, body?: React.ReactNode) => {
    width = columns
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: 44 }, body, React.createElement(SettingsPopupSlot)))), columns, 44)
  }
  const until = async (needle: string) => assert.ok(await waitFor(() => mounted!.screen().includes(needle), 15000), 'screen reaches ' + needle + '\n' + mounted!.screen())
  const heading = async (needle: string) => assert.ok(await waitFor(() => mounted!.lines().slice(0, 4).join(' ').includes(needle), 15000), 'question reaches ' + needle + '\n' + mounted!.screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const walk = async (needle: string, key: string = KEY.down) => {
    for (let n = 0; n < 80; n++) {
      const before = selected()
      if (before.includes(needle)) return
      mounted!.push(key)
      assert.ok(await waitFor(() => selected() !== before, 3000), 'selection reaches ' + needle + '\n' + mounted!.screen())
    }
    throw new Error('Choice not found: ' + needle)
  }
  const choose = async (needle: string) => { await walk(needle); mounted!.push(KEY.enter) }
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  const capture = async (name: string) => {
    const screen = mounted!.screen()
    check(name + ' has an exit and no render error or key', screen.includes('esc') && !screen.includes('RENDER ERROR') && !screen.includes(rp.key))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), screen)
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: 44 }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  open(); await mount(120)
  await heading('Which model?')
  const names = [...new Set(recipes.map(recipe => recipe.label.split(' · ')[0]!))]
  const modelRows = [selected()]
  const modelPages = [mounted!.screen()]
  for (let index = 1; index < names.length; index++) {
    const before = selected()
    mounted!.push(KEY.down)
    assert.ok(await waitFor(() => selected() !== before, 3000), 'every model is reachable in the paged catalogue')
    modelRows.push(selected())
    modelPages.push(mounted!.screen())
  }
  await walk('GLM-5.3-Flash', KEY.up)
  const screen1 = modelPages.join('\n')
  check('Screen 1 has one row per model, with no filenames', names.every(name => modelRows.filter(line => line.includes(name.padEnd(Math.max(...names.map(name => name.length))) + ' · ')).length === 1) && !/\.gguf|UD-Q/.test(screen1))
  const at = (needle: string): number => { const index = screen1.indexOf(needle); assert.ok(index >= 0, 'Screen 1 carries ' + needle); return index }
  check('running first, then cheapest stock, then no stock', at('running on your machine') < at('in stock') && at('in stock') < at('no stock'))
  check('cursor starts on the already-paid model', selected().includes('GLM-5.3-Flash'))
  const screenTop = mounted!.screen()
  await walk('My computers'); const screenEnd = mounted!.screen(); await walk('GLM-5.3-Flash', KEY.up)
  check('account rows sit above the recipes on the opening frame and the other roads follow the divider below (the cursor returns to the paid model)', screenTop.includes('Machines I’m paying for · 1 · 1 running') && screenTop.includes('so far') && screenTop.includes('Vendor keys · Runpod ✓') && screenEnd.includes('My computers · 0') && screenEnd.includes('────────────────') && selected().includes('GLM-5.3-Flash'))
  check('opening the door never creates a pod', rp.state.creates === 0 && queued.length === 0)
  await capture('120-screen-1')
  mounted!.push(KEY.enter); await heading('GLM-5.3-Flash'); await until('THINKING')
  const screen2 = mounted!.screen()
  check('model values precede rental choices', ['QUALITY', 'CONVERSATIONS × CONTEXT', 'THINKING', 'WEIGHTS'].every((word, i, words) => screen2.includes(word) && (i === 0 || screen2.indexOf(words[i - 1]!) < screen2.indexOf(word))))
  check('model details omit developer dates and fit caveats', !/verified \d{4}|not measured|cannot promise/.test(screen2) && screen2.includes('/effort'))
  check('selected quality remains visible and alternatives stay reachable', screen2.includes('Balanced · 4-bit') && screen2.includes('Choose quality'))
  check('already running stays first', selected().includes('Already running') && selected().includes('fixture-paid'))
  await capture('120-screen-2')
  const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
  let sessionModel: string | null = null
  let switches = 0
  setFocusedSessionConnector({ ...noSessionConnector(), sessionId: () => 'door-proof', setModel: async model => { switches++; sessionModel = model; return { state: 'applied', setting: model } as never } })
  await choose('Already running'); await until('This session’s model:')
  check('already-running probes the server and switches through the focused session without a create', switches === 1 && sessionModel === 'compat/door-paid/' + f.model && rp.state.creates === 0)
  await close(); releaseFocusedSessionConnector()
  open(); await heading('Which model?'); await walk('Machines I’m paying for', KEY.up); mounted!.push(KEY.enter); await heading('Machines I’m paying for'); await choose('fixture-paid'); await heading('Machine controls')
  check('paid-pods row reaches the existing stop and terminate controls', mounted!.screen().includes('Stop ·') && mounted!.screen().includes('Terminate'))
  await close()
  rp.state.customGpus = [{ ...gpu, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }]
  open(); await heading('Which model?'); mounted!.push(KEY.enter); await heading('GLM-5.3-Flash'); await choose('Rent · Runpod')
  await heading('Confirm the hourly price'); await capture('120-screen-3')
  const measuredConfirm = mounted!.screen().replace(/[│\s]+/g, ' ')
  check('rental confirmation carries hardware, rate, region, context and quality', ['1× B300 · $8.99/hr', 'EU-NL-1', 'Tune: 4 × 128k', 'Balanced · 4-bit · max', 'Billing starts now', 'storage'].every(word => measuredConfirm.includes(word)))
  await choose('Cancel'); await close(); rp.state.customGpus = null
  open(); await heading('Which model?'); await choose('Qwen3.8-27B'); await heading('Qwen3.8-27B'); await choose('Rent · Runpod')
  await heading('Confirm the hourly price')
  await capture('120-fallback-confirm')
  const confirm = mounted!.screen().replace(/[│\s]+/g, ' ')
  check('confirm retains rate, disk, quality, source and billing consequences', ['$2.49/hr', '80 GB disk', 'rate unavailable', 'Qwen3.8-27B', '8-bit FP8', 'Weights: Hugging Face', 'Billing starts now', 'continues after closing', 'terminate deletes'].every(text => confirm.toLowerCase().includes(text.toLowerCase())) && !/documented|not measured/.test(confirm))
  check('money confirmation preselects nothing and still has no create', !selected() && rp.state.creates === 0)
  await choose('Confirm $2.49/hr'); await heading('Machine controls')
  check('confirmation uses the existing create exactly once and queues setup', rp.state.creates === 1 && queued.length === 1 && readHostRecord(queued[0]!)?.jobState === 'queued' && readHostRecord(queued[0]!)?.recipe === 'qwen38-27b-rtx-pro-6000')
  await close()
  open(); await heading('Which model?'); await choose('DeepSeek-V4.1'); await heading('DeepSeek-V4.1'); await choose('No stock · watch')
  await heading('Confirm the hourly price')
  check('no-stock reaches the existing stock-watch consent, not creation', mounted!.screen().includes('Watch for stock and rent at this price or less') && rp.state.creates === 1)
  await close()
  f.state.listed = false
  open(); await heading('Which model?'); mounted!.push(KEY.enter); await heading('GLM-5.3-Flash'); await choose('Already running'); await heading('Server is not answering')
  check('registered server failure offers retry, never a key screen', mounted!.screen().includes('Retry this server') && !mounted!.screen().includes('API key'))
  f.state.listed = true
  setFocusedSessionConnector({ ...noSessionConnector(), sessionId: () => 'door-proof', setModel: async model => { sessionModel = model; switches++; return { state: 'applied', setting: model } as never } })
  await choose('Retry this server'); await until('This session’s model:')
  check('retry switches after the server answers without renting again', switches === 2 && rp.state.creates === 1)
  await close(); releaseFocusedSessionConnector()
  mounted!.unmount(); mounted = undefined
  open(); await mount(80); await heading('Which model?'); await capture('80-screen-1')
  mounted!.push(KEY.enter); await heading('GLM-5.3-Flash'); await until('QUALITY'); await capture('80-screen-2')
  check('80-column model values and existing-machine action remain reachable', selected().includes('Already running') && !mounted!.screen().includes('cannot promise'))
  await close()
  rp.state.customGpus = [{ ...gpu, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }]
  open(); await heading('Which model?'); mounted!.push(KEY.enter); await heading('GLM-5.3-Flash'); await choose('Rent · Runpod'); await heading('Confirm the hourly price')
  await capture('80-screen-3')
  check('80-column confirm keeps billing and Cancel visible', mounted!.screen().replace(/[│\s]+/g, ' ').includes('Billing starts now') && mounted!.screen().includes('Cancel'))
  await choose('Cancel'); await until('Cancelled')
  check('cancel never adds a create', rp.state.creates === 1)
  await close(); rp.state.customGpus = null
  const { modelDoorRoad, runModelDoor, hostRunModelRows } = await import('../../src/services/host/door.ts')
  check('/model run rows omit the already-running model and link unopened recipes', !hostRunModelRows().some(row => row.name === 'GLM-5.3-Flash') && hostRunModelRows().some(row => row.name === 'Qwen3.8-27B' && row.tag === 'run it → /llmhost'))
  open(modelDoorRoad(road, 'Qwen3.8-27B')); await heading('Qwen3.8-27B'); await until('QUALITY')
  check('model-picker deep link opens Screen 2, not where or Screen 1', !mounted!.screen().includes('Which model?') && !mounted!.screen().includes('Where should the model run?'))
  await close()
  const { RunpodClient } = await import('../../src/services/host/runpod.ts')
  const api = new RunpodClient(rp.key, rp.baseUrl)
  const questions: LlmHostQuestion[] = []
  const fakeRoad: LlmHostRoad = async () => ({ ok: true, words: 'existing road' })
  await runModelDoor(async question => { questions.push(question); return questions.length === 1 ? 'GLM-5.3-Flash' : null }, () => {}, new AbortController().signal, { offers: () => api.offers(new AbortController().signal), pods: async () => [], records: () => [], road: fakeRoad, boxes: () => [{ name: 'fixture-box', kind: 'ssh', os: 'linux', memoryGb: runningRecipe.vramGb, unifiedMemory: false, engines: [] }], budgetLines: () => ['4 × 131,072 · fixture budget'] })
  check('box seam sorts an own computer ahead of rentals and selects it', questions[0]?.rows?.find(row => row.value === questions[0]?.initial)?.label.includes('fits fixture-box (288 GB)') && questions[0].rows?.find(row => row.value === 'GLM-5.3-Flash')?.label.includes('fits fixture-box (288 GB)'))
  check('model page keeps actions and omits the optional memory explanation', !questions[1]?.found.includes('fixture budget') && !questions[1]?.rows?.some(row => row.label.includes('Vast') || row.label.includes('Lambda')))
  mounted!.unmount(); mounted = undefined
  const { call: modelCall } = await import('../../src/commands/model/mercuryModel.tsx')
  let finishPicker = () => {}
  const modelNode = await modelCall(() => finishPicker(), { messages: [] } as never, 'Qwen3.8-27B')
  function PickerHost() {
    const [visible, setVisible] = React.useState(true)
    finishPicker = () => setVisible(false)
    return visible ? modelNode : null
  }
  await mount(120, React.createElement(PickerHost))
  await until('run it → /llmhost')
  check('real /model paints the run-it action', mounted!.screen().includes('Qwen3.8-27B'))
  for (let n = 0; n < 6 && !popup.isSettingsPopupOpen(); n++) {
    mounted!.push(KEY.down); mounted!.push(KEY.enter)
    await waitFor(() => popup.isSettingsPopupOpen(), 500)
  }
  await heading('Qwen3.8-27B'); await until('CONVERSATIONS × CONTEXT')
  check('real /model action opens the matching model page without another rental', rp.state.creates === 1 && !mounted!.screen().includes('Which model?'))
  await close()
  mounted!.unmount(); mounted = undefined
  const { refreshCompatCatalogues } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
  await refreshCompatCatalogues({ force: true, name: 'door-paid', fetchImpl: Object.assign(async () => { throw new Error('fixture server is offline') }, nativeFetch) })
  const retryNode = await modelCall(() => {}, { messages: [] } as never, 'door-paid')
  await mount(120, retryNode); await until('server is not answering')
  check('real /model marks an offline registered endpoint and offers retry, not sign-in', mounted!.screen().includes('Retry this server') && !mounted!.screen().includes('API key'))
  const reads = f.state.requests
  mounted!.push(KEY.tab); mounted!.push(KEY.enter)
  await until('models ready')
  check('registered endpoint retry rereads its catalogue without opening a key screen', f.state.requests > reads && !popup.isSettingsPopupOpen())
  check('Mac fit seam adds a local run label only when the recipe fits', hostRunModelRows([{ name: 'Mac', kind: 'this-computer', os: 'darwin', memoryGb: 96, unifiedMemory: true, engines: [] }]).some(row => row.name === 'Qwen3.8-27B' && row.tag.includes('run it on this Mac →')))
  check('all network requests stay on loopback fixtures', escaped.length === 0)
  console.log('DOOR DRIVE GREEN — ' + checks + ' checks; real popup at 120 and 80 columns; loopback only; zero billable calls')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); f.close(); globalThis.fetch = nativeFetch }
