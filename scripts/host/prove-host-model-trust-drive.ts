import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, liveCatalogue } from './runpodFixture.mjs'
import { hfFixture, fixtureRepos } from './hfFixture.mjs'
import type { LlmHostQuestion } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
pinSourceRef()
const f = await llmhostFixture()
process.env.HOME = f.home
const rp = await runpodFixture()
const hf = await hfFixture()
process.env.MERCURY_HOST_HF_API_BASE = hf.baseUrl
const fetchBefore = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(url.origin); throw new Error('Only loopback fixtures are allowed') }
  return fetchBefore(request)
}, fetchBefore)
let mounted: Mounted | undefined
try {
  const shipped = JSON.parse(readFileSync(join(f.root, 'assets/host/recipes.json'), 'utf8'))
  const base = shipped.recipes.find((row: any) => row.id === 'deepseek41-b200')
  const privateName = 'DeepSeek-V4.1-Flash UNCENSORED (dealignai)'
  const foundName = 'dealignai/DeepSeek-V4.1-Flash-1017-EXL3-2.9bpw-UNCENSORED'
  const privateRow = { ...base, id: 'private-deepseek', label: privateName, model: 'fixture/private-deepseek', verified: { by: 'documented', on: '2026-10-22', source: 'https://huggingface.co/fixture/private-deepseek' } }
  const unverified = { ...base, id: 'saved-search-deepseek', label: foundName + ' · EXL3', model: foundName, gpu: 'H100', count: 1, vramGb: 80, verified: { by: 'unverified', on: '2026-10-22', source: 'https://huggingface.co/' + foundName, note: "derived from the repo's config and file list; nobody has booted this recipe" }, verification: 'unverified · derived from the repo · vLLM (EXL3) · not booted' }
  const measured = { ...privateRow, id: 'measured-deepseek', label: 'DeepSeek measured', model: 'fixture/measured-deepseek', verified: { ...privateRow.verified, by: 'measured' } }
  const inStock = { ...privateRow, id: 'documented-in-stock', label: 'DeepSeek documented stock', model: 'fixture/documented-stock', gpu: 'H100', count: 1, vramGb: 80 }
  const privateUnverified = { ...privateRow, id: 'private-unverified', label: 'DeepSeek private experiment', verified: { ...privateRow.verified, by: 'unverified' } }
  const recipeFile = join(f.home, 'recipes.json')
  writeFileSync(recipeFile, JSON.stringify({ version: shipped.version, publishedAt: shipped.publishedAt, recipes: [unverified, privateRow, measured, inStock, privateUnverified] }))
  process.env.MERCURY_HOST_RECIPES_FILE = recipeFile
  rp.state.customGpus = [{ ...liveCatalogue.gpus.find((row: any) => row.id === 'NVIDIA H100 80GB HBM3'), availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }]
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { derivedHfRecipe, forgetDerivedHfRecipes } = await import('../../src/services/host/hfRecipes.ts')
  const { forgetSessionHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  writeStoredRunpodApiKey(rp.key)
  const frameAt = process.argv.indexOf('--frames')
  const frames = frameAt < 0 ? undefined : process.argv[frameAt + 1]
  if (frames) mkdirSync(frames, { recursive: true })
  for (const width of [120, 80]) {
    forgetDerivedHfRecipes(); forgetSessionHostRecipes()
    let question: LlmHostQuestion | undefined
    const implementation = createHostRoad({ apiBaseUrl: rp.baseUrl, sessionId: 'trust-' + width, runner: { run: async () => '', tunnel: () => { throw new Error('No tunnel is needed') } }, startJob: () => { throw new Error('No rental is allowed') } })
    const height = width === 80 ? 24 : 40
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
    popup.openSettingsPopup(llmHostPopupRequest((ask, emit, signal) => implementation(plan => { question = plan; return ask(plan) }, emit, signal)))
    const screen = () => mounted!.screen()
    const flat = () => screen().replace(/[│\s]+/g, ' ')
    const step = async (value: string) => assert.ok(await waitFor(() => question?.step === value && screen().includes(question.title.slice(0, 20)), 15000), value + '\n' + screen())
    const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
    const select = async (value: string) => {
      const row = question!.rows!.find(row => row.value === value)
      assert.ok(row, value)
      const title = row.label.split('\n').at(-1)!.slice(0, 28)
      for (const key of [KEY.down, KEY.up]) for (let n = 0; n < 30 && !selected().includes(title); n++) { const before = selected(); mounted!.push(key); if (!await waitFor(() => selected() !== before, 1000)) break }
      assert.ok(selected().includes(title), value + '\n' + screen())
    }
    const choose = async (value: string) => { await select(value); mounted!.push(KEY.enter) }
    const capture = async (name: string) => {
      if (!frames) return
      writeFileSync(join(frames, width + '-' + name + '.txt'), screen())
      const grid = mounted!.lines().map(line => Array.from(line.padEnd(width)).map(c => ({ c, bg: 'default', fg: 'default', bold: false })))
      const file = join(frames, width + '-' + name + '.json')
      writeFileSync(file, JSON.stringify({ grid, cols: width, rows: height }))
      const { gridToPng } = await import('../ui/gridToPng.ts')
      await gridToPng(file, join(frames, width + '-' + name + '.png'))
    }
    await step('door-models')
    const values = question!.rows!.map(row => row.value)
    assert.deepEqual(values.slice(0, 5), [measured.label, inStock.label, privateName, privateUnverified.label, foundName], 'verification tier precedes stock; a private unverified row also precedes search-derived stock')
    assert.ok(question!.rows![4]!.label.includes('in stock'))
    assert.ok(question!.rows![2]!.label.includes('no stock'))
    assert.equal(question!.initial, measured.label)
    await select(foundName)
    assert.ok(flat().includes('found on Hugging Face · not booted by Mercury · EXL3'), 'saved search-derived rows name their source and keep the format after the warning\n' + screen())
    await capture('saved-search')
    mounted!.push('deepseek')
    assert.ok(await waitFor(() => question?.rows?.some(row => row.value === 'hf:' + fixtureRepos.gguf.id) === true, 15000))
    const rows = question!.rows!
    assert.ok(rows.findIndex(row => row.value === privateName) < rows.findIndex(row => row.value === 'hf:' + fixtureRepos.gguf.id))
    await select('hf:' + fixtureRepos.gguf.id)
    assert.ok(flat().includes('found on Hugging Face · not booted by Mercury · GGUF Q4_K_M'))
    await capture('live-search')
    mounted!.push(KEY.enter); await step('door-model')
    assert.ok(derivedHfRecipe(fixtureRepos.gguf.id)!.recipe.label.includes('found on Hugging Face · not booted by Mercury · GGUF Q4_K_M'))
    await choose('rent:0'); await step('rent-confirm')
    assert.ok(question!.found.includes('found on Hugging Face · not booted by Mercury · GGUF Q4_K_M'))
    assert.equal(rp.state.creates, 0)
    await capture('rental-confirm')
    mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)); mounted.unmount(); mounted = undefined
    console.log('PASS source labels at ' + width + ': saved, live search, derived recipe and rental confirmation distinguish the unbooted Hugging Face model; nothing rented')
  }
  assert.equal(escaped.length, 0)
} finally { mounted?.unmount(); await rp.close(); await hf.close(); f.close(); globalThis.fetch = fetchBefore }
