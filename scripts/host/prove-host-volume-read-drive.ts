import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import type { LlmHostQuestion } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
pinSourceRef()
const f = await llmhostFixture()
process.env.HOME = f.home
const rp = await runpodFixture()
const vast = await vastFixture()
const originalFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(url.origin); throw new Error('Only loopback fixtures are allowed') }
  return originalFetch(request)
}, originalFetch)
let mounted: Mounted | undefined
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { rememberBankFolder } = await import('../../src/services/host/bank.ts')
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const recipes = join(f.home, 'recipes.json')
  writeFileSync(recipes, JSON.stringify({ version: 2, publishedAt: '2026-10-22', recipes: [HOST_RECIPES.find(row => row.id === 'gpt-oss-120b-h100')] }))
  process.env.MERCURY_HOST_RECIPES_FILE = recipes
  rememberBankFolder(join(f.home, 'mercury-model-bank'))
  const frameAt = process.argv.indexOf('--frames')
  const frames = frameAt < 0 ? undefined : process.argv[frameAt + 1]
  if (frames) mkdirSync(frames, { recursive: true })
  for (const width of [120, 80]) for (const [vendor, label, fixture] of [['runpod', 'Runpod', rp], ['vast', 'Vast.ai', vast]] as const) {
    saveVendorKey('runpod', null)
    saveVendorKey('vast', null)
    saveVendorKey(vendor, 'fixture-rejected-' + width + '-' + vendor)
    let question: LlmHostQuestion | undefined
    const notices: string[] = []
    const implementation = createHostRoad({ apiBaseUrl: rp.baseUrl, vendorApiBaseUrls: { vast: vast.baseUrl }, sessionId: 'volume-reads-' + width + '-' + vendor, runner: { run: async () => '', tunnel: () => { throw new Error('No tunnel is needed') } } })
    const height = width === 120 ? 40 : 24
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
    const screen = () => mounted!.screen()
    const flat = () => screen().replace(/[│\s]+/g, ' ')
    const step = async (name: string) => assert.ok(await waitFor(() => question?.step === name && screen().includes(question.title.slice(0, 20)), 15000), name + '\n' + screen())
    const open = async () => { popup.openSettingsPopup(llmHostPopupRequest((ask, emit, signal) => implementation(plan => { question = plan; return ask(plan) }, event => { notices.push(event.words); emit(event) }, signal))); await step('door-models') }
    const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
    const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
    const choose = async (value: string) => {
      const row = question!.rows!.find(row => row.value === value)
      assert.ok(row, value)
      const title = row.label.split('\n').at(-1)!.slice(0, 20)
      for (const key of [KEY.down, KEY.up]) for (let i = 0; i < 20 && !selected().includes(title); i++) { const before = selected(); mounted!.push(key); if (!await waitFor(() => selected() !== before, 500)) break }
      assert.ok(selected().includes(title), value + '\n' + screen())
      mounted!.push(KEY.enter)
    }
    const reads = () => fixture.requests.length
    await open()
    const before = reads()
    assert.ok(before > 0)
    await choose('bank'); await step('door-bank')
    assert.equal(reads(), before, label + ' Bank must not re-read a credential already rejected by the machine list')
    assert.equal(notices.length, 0, label + ' has one summary, not a second raw volume notice')
    assert.equal(flat().split(label + ': could not be read (HTTP 401)').length - 1, 1)
    assert.ok(!flat().includes('GET /'))
    await choose('vendor-error:' + vendor); await step('door-vendor-error')
    assert.ok(question!.found.includes('HTTP 401'))
    assert.ok(!question!.found.includes('fixture-rejected'))
    await close(); await open(); await choose('pods'); await step('paid-pods')
    assert.equal(reads(), before, label + ' paid list must not re-read a parked credential')
    assert.ok(question!.found.includes(label + ': unread'))
    assert.equal(notices.length, 0)
    if (frames) {
      writeFileSync(join(frames, width + '-' + vendor + '.txt'), screen())
      const grid = mounted!.lines().map(line => Array.from(line.padEnd(width)).map(c => ({ c, bg: 'default', fg: 'default', bold: false })))
      const file = join(frames, width + '-' + vendor + '.json')
      writeFileSync(file, JSON.stringify({ grid, cols: width, rows: height }))
      const { gridToPng } = await import('../ui/gridToPng.ts')
      await gridToPng(file, join(frames, width + '-' + vendor + '.png'))
    }
    await close()
    saveVendorKey(vendor, fixture.key)
    await open(); await choose('bank'); await step('door-bank')
    assert.ok(reads() > before)
    assert.ok(!question!.found.includes('could not be read'))
    await close(); mounted.unmount(); mounted = undefined
    console.log('PASS ' + label + ' at ' + width + ': one credential failure, Bank and paid volumes stay parked, HTTP detail preserved, changed key resumes reads')
  }
  assert.equal(escaped.length, 0)
  assert.equal(rp.state.creates + vast.state.creates + rp.state.volumeCreates + vast.state.volumeCreates, 0)
  console.log('HOST VOLUME READ DRIVE GREEN — all reads stayed on loopback; no rentals or volumes created')
} finally { mounted?.unmount(); await rp.close(); await vast.close(); f.close(); globalThis.fetch = originalFetch }
