import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'
import type { LlmHostQuestion } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
process.env.HOME = f.home
const vast = await vastFixture()
const lambda = await lambdaFixture()
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
  const data = Buffer.from('fixture upload weights')
  const digest = createHash('sha256').update(data).digest('hex')
  const recipe = { ...shipped.recipes.find((row: any) => row.id === 'gpt-oss-120b-h100'), id: 'upload-fixture', label: 'Upload fixture · MXFP4', model: 'fixture/upload', weightsGb: data.length / 1e9, weightManifest: { model: 'fixture/upload', include: '', revision: 'a'.repeat(40), files: [{ path: 'weights.bin', size: data.length, sha256: digest }] } }
  const file = join(f.home, 'recipes.json')
  writeFileSync(file, JSON.stringify({ version: shipped.version, publishedAt: shipped.publishedAt, recipes: [recipe] }))
  process.env.MERCURY_HOST_RECIPES_FILE = file
  vast.state.customOffers = [{ id: 101, gpu_name: 'H100', gpu_ram: 80 * 1024, num_gpus: 1, dph_total: 1.2, verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000, machine_id: 9101 }]
  const bank = await import('../../src/services/host/bank.ts')
  const safe = await import('../../src/services/host/keepSafe.ts')
  const folder = bank.rememberBankFolder(join(f.home, 'mercury-model-bank'))
  const path = bank.bankModelFolder(folder, recipe)
  mkdirSync(path)
  writeFileSync(join(path, 'weights.bin'), data)
  writeFileSync(join(path, 'SHA256SUMS'), digest + '  weights.bin\n')
  const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  saveVendorKey('vast', vast.key); saveVendorKey('lambda', lambda.key)
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  for (const width of [120, 80]) {
    safe.rememberBankUpload(recipe, undefined)
    let question: LlmHostQuestion | undefined
    const road = createHostRoad({ sessionId: 'upload-' + width, vendorApiBaseUrls: { vast: vast.baseUrl, lambda: lambda.baseUrl }, runner: { run: async () => { throw new Error('No process is needed') }, tunnel: () => { throw new Error('No tunnel is needed') } }, startJob: () => { throw new Error('No rental is allowed') } })
    const height = width === 80 ? 24 : 40
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
    const screen = () => mounted!.screen()
    const step = async (name: string) => assert.ok(await waitFor(() => question?.step === name && screen().includes(question.title.slice(0, 20)), 15000), name + '\n' + screen())
    const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
    const choose = async (value: string) => {
      const row = question!.rows!.find(row => row.value === value)
      assert.ok(row, value)
      const title = row.label.split('\n').at(-1)!.slice(0, 22)
      for (const key of [KEY.down, KEY.up]) for (let i = 0; i < 30 && !selected().includes(title); i++) { const before = selected(); mounted!.push(key); if (!await waitFor(() => selected() !== before, 500)) break }
      assert.ok(selected().includes(title), value + '\n' + screen())
      mounted!.push(KEY.enter)
    }
    const open = async () => { popup.openSettingsPopup(llmHostPopupRequest((ask, emit, signal) => road(plan => { question = plan; return ask(plan) }, emit, signal))); await step('door-models'); await choose('Upload fixture'); await step('door-model') }
    const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
    await open()
    mounted!.push('k'); await step('bank-keep-safe')
    await choose('upload'); await step('bank-upload-speed'); mounted!.push('25'); assert.ok(await waitFor(() => screen().includes('25'), 3000)); mounted!.push(KEY.enter)
    await step('bank-upload-confirm')
    assert.ok(question!.willRun.includes('bills throughout the upload'))
    await choose('upload'); await step('door-model')
    assert.equal(safe.bankUploadPreference(recipe)?.bytesPerSecond, 25e6 / 8)
    for (const label of ['Vast.ai', 'Lambda']) {
      const row = question!.rows!.find(row => row.label.startsWith('Rent · ' + label))!
      assert.ok(row)
      assert.ok(row.label.includes('uploads your bank first'), 'the rental row must match the saved upload choice')
      assert.ok(question!.found.includes('upload your bank'), 'the WEIGHTS summary must not promise an HF download for an upload')
      await choose(row.value); await step('rent-confirm')
      assert.ok(question!.willRun.includes('Uploads your bank to the rented machine · ' + safe.bankUploadEstimate(recipe)))
      assert.ok(question!.willRun.includes('This machine bills throughout the upload.'))
      assert.equal(vast.state.creates + lambda.state.creates, 0)
      await close(); await open()
    }
    await close()
    const volumes = await import('../../src/services/host/volumes.ts')
    for (const [state, machineId, rowWords, confirmation] of [['preparing', 9101, 'downloads onto your volume first', 'downloads the weights onto your Vast.ai volume'], ['kept', 9101, 'boots from your Vast.ai volume on its machine', 'the download is skipped'], ['kept', 9999, 'uploads your bank first', 'Uploads your bank to the rented machine']] as const) {
      vast.state.volumes.set(20199999, { id: 20199999, label: 'fixture-kept', machine_id: machineId, disk_space: 20, storage_cost: 0.2, status: 'active', start_date: 1792490400 })
      volumes.writeKeptVolume({ id: '20199999', name: 'fixture-kept', model: recipe.model, include: '', recipeRow: recipe, kind: 'vast', machineId, dataCenter: 'Vast.ai machine ' + machineId, size: 20, price: 4, storageCost: 0.2, createdAt: new Date().toISOString(), state })
      await open()
      const row = question!.rows!.find(row => row.label.startsWith('Rent · Vast.ai'))!
      assert.ok(row.label.includes(rowWords), row.label)
      await choose(row.value); await step('rent-confirm')
      assert.ok(question!.willRun.includes(confirmation), question!.willRun)
      if (machineId === 9999) assert.ok(question!.willRun.includes('it stays there and bills'))
      assert.equal(vast.state.creates + lambda.state.creates, 0)
      await close()
    }
    vast.state.volumes.clear(); volumes.removeKeptVolumeRecord('20199999')
    mounted.unmount(); mounted = undefined
    console.log('PASS k keep safe on the fresh model and saved first-boot upload confirms for Vast.ai/Lambda at ' + width + ' columns; no rentals')
  }
  assert.equal(escaped.length, 0)
} finally { mounted?.unmount(); await vast.close(); await lambda.close(); f.close(); globalThis.fetch = fetchBefore }
