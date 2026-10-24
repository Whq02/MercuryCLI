import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { runpodFixture, liveCatalogue } from './runpodFixture.mjs'
import { hfFixture } from './hfFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
delete process.env.HF_TOKEN
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const rp = await runpodFixture()
const hf = await hfFixture()
process.env.MERCURY_HOST_HF_API_BASE = hf.baseUrl
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === 'https://api.runpod.io') return nativeFetch(new Request(rp.baseUrl.replace('/v2', '') + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('Search proof only permits loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
let mounted: Mounted | undefined
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name + (mounted ? '\n' + mounted.screen() : '')); checks++; console.log('PASS ' + name) }
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const { HF_SEARCH_PLACEHOLDER, HF_OFFLINE_WORDS, HF_GATED_WORDS, HF_NOT_CHAT_WORDS } = await import('../../src/services/host/hfRecipes.ts')
  writeStoredRunpodApiKey(rp.key)
  const names = [...new Set(currentHostRecipes().map(recipe => recipe.label.split(' · ')[0]!))]
  const h100 = liveCatalogue.gpus.find((row: any) => row.id === 'NVIDIA H100 80GB HBM3')!
  const b200 = liveCatalogue.gpus.find((row: any) => row.id === 'NVIDIA B200')!
  rp.state.customGpus = [{ ...h100, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }, { ...b200, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }]
  const queued: string[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, sessionId: 'search-proof', startJob: record => { queued.push(record.id) } })
  let width = 120
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  const mount = async (columns: number) => {
    width = columns
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: 44 }, React.createElement(SettingsPopupSlot)))), columns, 44)
  }
  const screen = () => mounted!.screen()
  const until = async (needle: string, ms = 15000) => assert.ok(await waitFor(() => screen().includes(needle), ms), 'screen reaches ' + needle + '\n' + screen())
  const gone = async (needle: string, ms = 15000) => assert.ok(await waitFor(() => !screen().includes(needle), ms), 'screen drops ' + needle + '\n' + screen())
  const heading = async (needle: string) => assert.ok(await waitFor(() => mounted!.lines().slice(0, 4).join(' ').includes(needle), 15000), 'question reaches ' + needle + '\n' + screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const choose = async (needle: string) => {
    for (let n = 0; n < 40; n++) {
      const before = selected()
      if (before.includes(needle)) { mounted!.push(KEY.enter); return }
      mounted!.push(KEY.down)
      assert.ok(await waitFor(() => selected() !== before, 3000), 'selection reaches ' + needle + '\n' + screen())
    }
    throw new Error('Choice not found: ' + needle)
  }
  const type = (text: string) => { for (const char of text) mounted!.push(char) }
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000), 'the popup closes\n' + screen()) }
  const capture = async (name: string) => {
    const shot = screen()
    check(name + ' has an exit and no render error or key', shot.includes('esc') && !shot.includes('RENDER ERROR') && !shot.includes(rp.key) && !shot.includes(hf.token))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), shot)
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: 44 }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  const ggufRow = 'DeepSeek-V4.1-Flash-GGUF'
  const hfHeading = 'HUGGING FACE · 4 results'

  open(); await mount(120)
  await heading('Which model?')
  const pages = [screen()]
  const first = selected()
  for (let index = 0; index < names.length + 4; index++) {
    const before = selected()
    mounted!.push(KEY.down)
    assert.ok(await waitFor(() => selected() !== before, 3000), 'every model and utility row is reachable\n' + screen())
    pages.push(screen())
  }
  for (let index = 0; index < names.length + 4; index++) {
    const before = selected()
    mounted!.push(KEY.up)
    assert.ok(await waitFor(() => selected() !== before, 3000), 'return to the suggested model\n' + screen())
  }
  assert.equal(selected(), first)
  const plain = pages.join('\n')
  check('without a query the popup is today’s popup plus the search line and the Bank row', plain.includes(HF_SEARCH_PLACEHOLDER) && plain.includes('Bank · your weights') && names.every(name => plain.includes(name)) && plain.includes('Machines I’m paying for') && plain.includes('My computers') && plain.includes('Refresh stock and prices') && plain.includes('More options') && !plain.includes('HUGGING FACE') && !plain.includes('VERIFIED RECIPES'))
  check('model tier ordering stays internal without stamps on rows', !/ · (measured|documented|community|unverified)\b/.test(plain) && selected().includes('GLM-5.3-Flash'))
  check('opening the door never creates a pod or reaches Hugging Face', rp.state.creates === 0 && hf.state.searches === 0)
  hf.state.delayMs = 300
  type('deepseek')
  assert.ok(await waitFor(() => !screen().includes('GLM-5.3-Flash') && screen().includes('DeepSeek-V4.1-Flash-1017'), 400), 'the verified rows narrow at once\n' + screen())
  const narrowed = screen()
  check('typing filters models by name', narrowed.includes('MODELS') && narrowed.includes('DeepSeek-V4-Pro-0813') && !narrowed.includes('Qwen3.8-27B') && !narrowed.includes('Machines I’m paying for') && narrowed.includes('/ deepseek'))
  await until('HUGGING FACE · fetching…', 3000)
  check('the Hugging Face section says fetching while the request runs and the verified rows stand', screen().includes('DeepSeek-V4.1-Flash-1017') && hf.state.searches === 1)
  await until(hfHeading)
  const results = screen().replace(/[│\s]+/g, ' ')
  check('search retains model facts and access without provenance', results.includes('deepseek-ai/DeepSeek-V4.1-Flash-1017') && results.includes('284B · safetensors FP8 · ↓ 3.4M · MIT') && results.includes('unsloth/' + ggufRow) && results.includes('284B · GGUF Q4_K_M · ↓ 412k · MIT') && results.includes('mercury-bounties/deepseek-coder-v4-bounty') && results.includes('gated') && results.includes(HF_NOT_CHAT_WORDS) && !results.includes('unverified'))
  check('the search fired once for the settled query, with the fields the rows need', hf.state.searches === 1 && hf.state.lastSearch?.query === 'deepseek' && hf.state.lastSearch!.params.includes('pipeline_tag=text-generation') && hf.state.lastSearch!.params.includes('sort=downloads'))
  check('the hint says what esc does while a query stands', screen().includes('esc clears the search'))
  await capture('120-search')
  await choose(ggufRow)
  await heading('unsloth/' + ggufRow); await until('WEIGHTS')
  const model = screen().replace(/[│\s]+/g, ' ')
  check('model detail omits the provenance paragraph and false guard promise', !/RECIPE ·|not booted|terminated automatically/.test(model) && model.includes('120 GB'))
  check('the derived recipe keeps its hardware and live price', model.includes('2× H100') && model.includes('Rent · Runpod 2× H100 · $7.98/hr') && hf.state.trees === 1 && hf.state.configs === 0)
  check('model values remain visible', ['QUALITY', 'CONVERSATIONS × CONTEXT', 'THINKING', 'WEIGHTS'].every(word => model.includes(word)))
  await capture('120-model')
  await choose('Rent · Runpod')
  await heading('Confirm the hourly price')
  const confirm = screen().replace(/[│\s]+/g, ' ')
  check('derived rental consent retains shape, price, billing and Cancel', confirm.includes('2× H100') && confirm.includes('$7.98/hr') && confirm.includes('unsloth/' + ggufRow) && confirm.includes('Billing starts now') && confirm.includes('Cancel'))
  check('source selection remains visible without a tier label', confirm.includes('Weights: Hugging Face') && !confirm.includes('unverified'))
  await capture('120-confirm')
  await choose('Cancel')
  check('refusing the price creates nothing and queues nothing', rp.state.creates === 0 && queued.length === 0)
  await close()

  open(); await heading('Which model?')
  type('deepseek'); await until(hfHeading)
  check('a new popup fetches afresh', hf.state.searches === 2)
  mounted!.push(KEY.esc)
  await gone('HUGGING FACE'); await until('GLM-5.3-Flash')
  const cleared = screen()
  for (let index = 0; index < names.length && !screen().includes('Machines I’m paying for'); index++) {
    const before = selected()
    mounted!.push(KEY.down)
    assert.ok(await waitFor(() => selected() !== before, 3000), 'cleared search restores the utility rows\n' + screen())
  }
  check('esc with a query clears it: the full verified list and the placeholder return, nothing closes', popup.isSettingsPopupOpen() && cleared.includes(HF_SEARCH_PLACEHOLDER) && screen().includes('Machines I’m paying for') && hf.state.searches === 2)
  type('deepseek'); await until(hfHeading)
  check('the same query in the same popup never refetches', hf.state.searches === 2)
  await choose('mercury-bounties/deepseek-coder-v4-bounty')
  await until(HF_GATED_WORDS)
  check('a gated repo without a sign-in says sign in with /logins huggingface and stays on the list', mounted!.lines().slice(0, 4).join(' ').includes('Which model?') && screen().includes('mercury-bounties/deepseek-coder-v4-bounty · ' + HF_GATED_WORDS) && hf.state.trees === 1)
  await choose('DeepSeek-OCR-2')
  await until('DeepSeek-OCR-2 · ' + HF_NOT_CHAT_WORDS)
  check('a vision repo cannot be picked', mounted!.lines().slice(0, 4).join(' ').includes('Which model?') && hf.state.trees === 1)
  await choose(ggufRow)
  await heading('unsloth/' + ggufRow); await until('QUALITY')
  check('a repo picked before opens again without a second derivation', hf.state.trees === 1)
  await choose('Back to models'); await heading('Which model?'); await until(hfHeading)
  check('back to models keeps the query and its results without a refetch', screen().includes('/ deepseek') && screen().includes('unsloth/' + ggufRow) && !screen().includes('GLM-5.3-Flash') && hf.state.searches === 2)
  mounted!.push(KEY.esc); await until(HF_SEARCH_PLACEHOLDER)
  await close()

  hf.state.down = true
  open(); await heading('Which model?')
  type('deepseek'); await until(HF_OFFLINE_WORDS)
  const offline = screen()
  check('with Hugging Face down the verified list stands and the section says so, never an error popup', offline.includes('HUGGING FACE · ' + HF_OFFLINE_WORDS) && offline.includes('DeepSeek-V4.1-Flash-1017') && offline.includes('DeepSeek-V4-Pro-0813') && !offline.includes('RENDER ERROR') && mounted!.lines().slice(0, 4).join(' ').includes('Which model?'))
  await capture('120-offline')
  mounted!.push(KEY.esc); await until(HF_SEARCH_PLACEHOLDER)
  check('esc clears the query even when Hugging Face was down', popup.isSettingsPopupOpen() && !screen().includes('HUGGING FACE'))
  await close()
  hf.state.down = false
  mounted!.unmount(); mounted = undefined

  open(); await mount(80); await heading('Which model?')
  type('deepseek'); await until(hfHeading)
  check('80 columns: the search, the narrowed verified rows and the Hugging Face rows all fit', screen().includes('/ deepseek') && screen().includes('unsloth/' + ggufRow) && !screen().includes('GLM-5.3-Flash'))
  await capture('80-search')
  await choose(ggufRow)
  await heading('unsloth/' + ggufRow)
  await until('QUALITY')
  check('80 columns opens on model values rather than a provenance paragraph', screen().includes('QUALITY') && !screen().includes('RECIPE ·'))
  await capture('80-model')
  await close()
  check('all network requests stayed on loopback fixtures and no pod was ever created', escaped.length === 0 && rp.state.creates === 0)
  console.log('HOST SEARCH DRIVE GREEN — ' + checks + ' checks; real popup at 120 and 80 columns; loopback only; zero billable calls')
} finally { mounted?.unmount(); await rp.close(); await hf.close(); globalThis.fetch = nativeFetch }
