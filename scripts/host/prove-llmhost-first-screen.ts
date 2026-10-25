import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner, liveCatalogue } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
pinSourceRef()
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
const rp = await runpodFixture()
const vast = await vastFixture()
const lambda = await lambdaFixture()
vast.state.noStock = true
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const base = ({ 'https://api.runpod.io': rp.baseUrl.replace('/v2', ''), 'https://console.vast.ai': vast.baseUrl.replace('/api/v0', ''), 'https://cloud.lambda.ai': lambda.baseUrl.replace('/api/v1', '') } as Record<string, string>)[url.origin]
  if (base) return nativeFetch(new Request(base + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('The first-screen proof permits loopback fixtures only') }
  return nativeFetch(request)
}, nativeFetch)
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
let checks = 0
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
  const { saveVendorKey, vendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { writeHostRecord, hostRecords } = await import('../../src/services/host/store.ts')
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const recipes = currentHostRecipes()
  const unlinkedRecipe = recipes.find(recipe => recipe.id === 'glm53-flash-gguf-b300')!
  const gpu = liveCatalogue.gpus.find((row: any) => row.id === 'NVIDIA B300 SXM6 AC')!
  const since = new Date(Date.now() - 3600_000).toISOString()
  rp.state.pods.set('fixture-orphan', { id: 'fixture-orphan', name: 'Orphan machine', status: 'RUNNING', cost: gpu.price.secure, createdAt: since, startedAt: since })
  rp.state.pods.set('fixture-unlinked', { id: 'fixture-unlinked', name: 'Unlinked machine', status: 'RUNNING', cost: gpu.price.secure, createdAt: since, startedAt: since })
  writeHostRecord({ id: 'fixture-unlinked', name: unlinkedRecipe.label, recipe: unlinkedRecipe.id, status: 'RUNNING', price: gpu.price.secure, startedAt: since, provider: 'gone-endpoint', jobState: 'ready' })
  vast.state.pods.set(7001, { id: 7001, label: 'owner-glm', actual_status: 'running', start_date: Math.floor(Date.now() / 1000) - 3600, dph_total: 2.1, ssh_host: 'ssh5.fixture.invalid', ssh_port: 17001, public_ipaddr: '127.0.0.1' })
  saveVendorKey('runpod', rp.key)
  saveVendorKey('vast', 'fixture-stale-vast-key')
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const queued: string[] = []
  let question: LlmHostQuestion | undefined
  const implementation = createHostRoad({ apiBaseUrl: rp.baseUrl, vendorApiBaseUrls: { vast: vast.baseUrl, lambda: lambda.baseUrl }, runner: ssh.runner, sessionId: 'first-screen-proof', startJob: record => { queued.push(record.id) } })
  const road: LlmHostRoad = (ask, emit, signal) => implementation(plan => { question = plan; return ask(plan) }, emit, signal)
  let width = 120, height = 40
  const screen = () => mounted?.screen() ?? ''
  const normal = () => screen().replace(/[│\s]+/g, ' ')
  const check = (name: string, truth: unknown) => { assert.ok(truth, name + '\n' + screen()); checks++; console.log('PASS ' + name) }
  const step = async (name: string) => assert.ok(await waitFor(() => question?.step === name && screen().includes(question.title.slice(0, 28)), 15000), 'question reaches ' + name + '\n' + screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const rowText = (row: NonNullable<LlmHostQuestion['rows']>[number]) => row.label.replace(/^─[^\n]*\n/, '').split('\n')[0]!.split(' · ')[0]!.trim()
  let tracked: { plan: LlmHostQuestion; at: number | null } | undefined
  const select = async (value: string) => {
    const plan = question!
    const rows = plan.rows ?? []
    const target = rows.findIndex(row => row.value === value)
    assert.ok(target >= 0, 'question offers ' + value + '\n' + screen())
    if (tracked?.plan !== plan) { const initial = plan.initial === undefined ? -1 : rows.findIndex(row => row.value === plan.initial); tracked = { plan, at: initial < 0 ? null : initial } }
    while (tracked.at !== target) {
      const before = selected()
      const down = tracked.at === null || tracked.at < target
      mounted!.push(down ? KEY.down : KEY.up)
      tracked.at = tracked.at === null ? (down ? 0 : rows.length - 1) : tracked.at + (down ? 1 : -1)
      assert.ok(await waitFor(() => selected() !== before, 3000), 'the cursor moves towards ' + value + '\n' + screen())
    }
    assert.ok(selected().includes(rowText(rows[target]!)), 'the cursor rests on ' + value + '\n' + screen())
  }
  const choose = async (value: string) => { await select(value); mounted!.push(KEY.enter) }
  const typeSecret = async (secret: string) => { mounted!.push(secret); assert.ok(await waitFor(() => screen().includes('*'.repeat(Math.min(8, secret.length))), 5000), 'the key field masks the entry\n' + screen()); mounted!.push(KEY.enter) }
  const capture = async (name: string) => {
    check(name + ' has intact borders, no render error and no credential', screen().includes('╰') && !screen().includes('RENDER ERROR') && [rp.key, vast.key, lambda.key, 'fixture-stale-vast-key'].every(key => !screen().includes(key)))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), screen())
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => ({ c, bg: mounted!.styleAt(x, y)?.bg ?? 'default', fg: mounted!.styleAt(x, y)?.fg ?? 'default', bold: mounted!.styleAt(x, y)?.bold ?? false })))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: height }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  const open = async () => { question = undefined; popup.openSettingsPopup(llmHostPopupRequest(road)); await step('door-models') }
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000), 'Escape closes\n' + screen()) }
  const mount = async (columns: number, rows: number) => { width = columns; height = rows; mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height) }
  const firstRecipe = () => question!.rows!.find(row => row.section === 'MODELS')!
  const aboveRecipes = (needle: string) => { const text = normal(); const at = text.indexOf(needle); const recipe = text.indexOf(rowText(firstRecipe()) + ' ·'); return at >= 0 && recipe >= 0 && at < recipe }
  const keysRow = () => question!.rows!.find(row => row.value === 'keys')
  const podsRow = () => question!.rows!.find(row => row.value === 'pods')!
  const noStockRows = () => question!.rows!.filter(row => row.section === 'MODELS' && row.label.includes('no stock'))

  await mount(120, 40)
  await open()
  await capture('120x40-first-screen')
  check('the first screen opens on the model list with no key pressed', question!.step === 'door-models' && selected().length > 0)
  check('key controls name connected vendors and the action for a refused key', keysRow() !== undefined && normal().includes('Vendor keys · Runpod ✓ · Vast.ai · replace key') && aboveRecipes('Vendor keys ·'))
  check('paid count includes vendor machines without records and marks an unread vendor', /Machines I’m paying for · 2\+\? · Vast\.ai unread · 2 running/.test(normal()) && aboveRecipes('Machines I’m paying for ·') && hostRecords().every(record => record.id !== 'fixture-orphan'))
  check('lost-record and de-registered pods are not promoted to model rows', !question!.rows!.some(row => row.section === 'MODELS' && row.label.includes('running on Runpod pod')))
  check('the refused Vast.ai key keeps its one-line notice and its detail row', normal().includes('Vast.ai: could not be read (HTTP 401) · replace the key to reconnect') && question!.rows!.some(row => row.value === 'vendor-error:vast'))
  check('a no-stock model names the shapes and the vendors whose stock was read, never the bare words', noStockRows().length > 0 && noStockRows().every(row => row.label.includes('no stock on Runpod · watch →')) && !question!.rows!.some(row => row.label.includes('no stock · watch →')))
  check('a running machine is never counted as stock', !question!.rows!.some(row => row.section === 'MODELS' && row.label.includes('in stock') && /fixture-orphan|fixture-unlinked|7001/.test(row.label)))
  check('opening the first screen rents nothing', rp.state.creates === 0 && vast.state.creates === 0 && lambda.state.creates === 0 && queued.length === 0)

  await choose('keys'); await step('door-keys')
  await capture('120x40-vendor-keys')
  check('the vendor-keys row opens the existing key controls: one row per saved key, a connect row for the rest, no Hugging Face row without a sign-in', question!.rows!.some(row => row.value === 'key:vast' && row.label === 'Vast.ai · Replace key / Remove key') && question!.rows!.some(row => row.value === 'key:runpod' && row.label === 'Runpod · Replace key / Remove key') && question!.rows!.some(row => row.value === 'connect:lambda' && row.label === 'Connect Lambda →') && !question!.rows!.some(row => row.value === 'key:huggingface'))
  await choose('key:vast'); await step('host-key-manage')
  await capture('120x40-vast-key-controls')
  check('choosing Vast.ai reaches the manageKey road: Replace key / Remove key for the Vast.ai API key', question!.title === 'Vast.ai API key' && question!.rows!.some(row => row.value === 'replace' && row.label === 'Replace key') && question!.rows!.some(row => row.value === 'remove' && row.label === 'Remove key'))
  await choose('replace'); await step('vast-key')
  check('the replacement is checked before the saved key changes', question!.willRun.includes('checked before replacing') && question!.secret === true)
  await typeSecret(vast.key)
  await step('door-models')
  assert.ok(await waitFor(() => normal().includes('Vast.ai ✓'), 15000), 'the first screen reopens with Vast.ai connected\n' + screen())
  await capture('120x40-first-screen-reconnected')
  check('the replaced key is saved and the notice disappears', vendorKey('vast') === vast.key && normal().includes('Vendor keys · Runpod ✓ · Vast.ai ✓') && !normal().includes('could not be read') && !question!.rows!.some(row => row.value === 'vendor-error:vast'))
  check('the reconnected vendor joins the live machine count', /Machines I’m paying for · 3 · 3 running/.test(normal()) && !hostRecords().some(record => record.id === '7001'))
  check('the no-stock words now name both vendors whose stock was read', noStockRows().length > 0 && noStockRows().every(row => row.label.includes('no stock on Runpod, Vast.ai · watch →')))
  await choose('pods'); await step('paid-pods')
  await capture('120x40-machines')
  check('Machines I’m paying for lists the lost-record Runpod pod and the Vast.ai instance, both running', question!.rows!.some(row => row.value === 'fixture-orphan' && row.label.includes('Orphan machine') && row.label.includes('running')) && question!.rows!.some(row => row.value === 'vast:7001' && row.label.includes('running')) && question!.found.includes('Runpod: 2 pods') && question!.found.includes('Vast.ai: 1 instances'))
  await choose('fixture-orphan'); await step('pod-controls')
  check('the lost-record pod reaches the existing machine controls, with Stop and Terminate', question!.rows!.some(row => row.value === 'stop') && question!.rows!.some(row => row.value === 'terminate'))
  await close()

  await open(); await choose('keys'); await step('door-keys'); await choose('key:vast'); await step('host-key-manage'); await choose('remove'); await step('host-key-remove')
  check('removal asks once more and says what keeps billing', question!.found.includes('Rented machines and disks keep billing') && question!.rows!.some(row => row.value === 'remove'))
  await choose('remove'); await step('door-models')
  assert.ok(await waitFor(() => normal().includes('Vast.ai · Lambda'), 15000), 'the first screen reopens with Vast.ai disconnected\n' + screen())
  check('removing the key stops account reads without changing vendor resources', vendorKey('vast') === undefined && normal().includes('Vendor keys · Runpod ✓ · Vast.ai · Lambda') && /Machines I’m paying for · 2 · 2 running/.test(normal()) && vast.state.deletes === 0 && vast.state.stops === 0)
  await choose('keys'); await step('door-keys')
  check('a disconnected vendor is offered a connect row in the key controls', question!.rows!.some(row => row.value === 'connect:vast' && row.label === 'Connect Vast.ai →') && !question!.rows!.some(row => row.value === 'key:vast'))
  await choose('connect:vast'); await step('vast-key')
  await typeSecret(vast.key)
  await step('door-models')
  assert.ok(await waitFor(() => normal().includes('Vast.ai ✓'), 15000), 'the first screen reopens with Vast.ai reconnected\n' + screen())
  check('connecting saves the checked key and reads the account again', vendorKey('vast') === vast.key && /Machines I’m paying for · 3 · 3 running/.test(normal()))
  await close()
  mounted!.unmount(); mounted = undefined

  await mount(80, 24)
  await open()
  await capture('80x24-first-screen')
  check('80×24 keeps account actions above the recipes', aboveRecipes('Machines I’m paying for ·') && aboveRecipes('Vendor keys ·') && /Machines I’m paying for · 3 · 3 running/.test(normal()) && normal().includes('Vendor keys · Runpod ✓ · Vast.ai ✓'))
  check('at 80×24 the cursor still starts on the first recipe, not on the account rows', selected().includes(rowText(firstRecipe())))
  await choose('keys'); await step('door-keys')
  await capture('80x24-vendor-keys')
  check('at 80×24 the key controls open from the first screen', question!.rows!.some(row => row.value === 'key:vast'))
  await choose('back'); await step('door-models')
  check('Back returns to the model list without re-reading or renting', question!.step === 'door-models' && rp.state.creates === 0 && vast.state.creates === 0)
  await close()
  mounted!.unmount(); mounted = undefined

  check('no request left the fixture servers and nothing was created anywhere', escaped.length === 0 && rp.state.creates === 0 && vast.state.creates === 0 && lambda.state.creates === 0 && queued.length === 0)
  console.log('LLMHOST FIRST SCREEN GREEN — ' + checks + ' checks; real popup at 120×40 and 80×24; key controls and running machines reachable from the first screen; loopback fixtures only; zero creates')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); await vast.close(); await lambda.close(); f.close(); globalThis.fetch = nativeFetch }
